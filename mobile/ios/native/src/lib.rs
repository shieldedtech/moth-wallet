//! Runs the (vendored, localhost-only) Midnight proof server inside the app process.
//! Moth's existing `server` prover mode then talks to http://127.0.0.1:<port> unchanged.
use std::ffi::{CStr, c_char};
use std::sync::mpsc;

/// Starts the proof server on a background thread. `params_dir` must be writable
/// (keys/SRS missing from it are downloaded there on demand). Returns the bound port, or -1.
#[unsafe(no_mangle)]
pub extern "C" fn mn_prover_start(params_dir: *const c_char, port: u16, workers: u32) -> i32 {
    let dir = unsafe { CStr::from_ptr(params_dir) }.to_string_lossy().into_owned();
    // SAFETY: called once at app start, before any other thread reads the environment.
    unsafe { std::env::set_var("MIDNIGHT_PP", dir) };
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("proof-server".into())
        .spawn(move || {
            // No tracing subscriber is installed on purpose: the proof server logs
            // request bodies (which contain spend keys) at debug level.
            actix_web::rt::System::new().block_on(async move {
                let pool = midnight_proof_server::worker_pool::WorkerPool::new(workers as usize, 4, 600.0);
                // Only the engine page may call the prover. `MOTH_PROVER_DEV_ORIGIN` adds one
                // more for the desktop harness (examples/run.rs); the app never sets it.
                let dev_origin = std::env::var("MOTH_PROVER_DEV_ORIGIN").ok();
                let mut origins = vec![midnight_proof_server::ENGINE_ORIGIN];
                origins.extend(dev_origin.as_deref());
                match midnight_proof_server::server(port, false, pool, &origins) {
                    Ok((srv, bound)) => {
                        let _ = tx.send(bound as i32);
                        let _ = srv.await;
                    }
                    Err(_) => {
                        let _ = tx.send(-1);
                    }
                }
            })
        })
        .expect("spawn proof-server thread");
    rx.recv().unwrap_or(-1)
}

/// Serves the bundled web app from `dir` on 127.0.0.1:`port` (fixed, so the page's
/// origin — and therefore its IndexedDB wallet storage — is stable across launches).
#[unsafe(no_mangle)]
pub extern "C" fn mn_static_start(dir: *const c_char, port: u16) -> i32 {
    use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
    let root = std::path::PathBuf::from(unsafe { CStr::from_ptr(dir) }.to_string_lossy().into_owned());
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("static-server".into())
        .spawn(move || {
            actix_web::rt::System::new().block_on(async move {
                let root = web::Data::new(root);
                let srv = HttpServer::new(move || {
                    App::new().app_data(root.clone()).default_service(web::to(
                        |req: HttpRequest, root: web::Data<std::path::PathBuf>| async move {
                            let rel = req.path().trim_start_matches('/');
                            let rel = if rel.is_empty() { "index.html" } else { rel };
                            if rel.split('/').any(|c| c == ".." || c.is_empty()) {
                                return HttpResponse::NotFound().finish();
                            }
                            match std::fs::read(root.join(rel)) {
                                Ok(bytes) => HttpResponse::Ok()
                                    .content_type(mime(rel))
                                    .insert_header(("Cache-Control", "no-store"))
                                    .body(bytes),
                                Err(_) => HttpResponse::NotFound().finish(),
                            }
                        },
                    ))
                })
                .workers(2)
                .bind(("127.0.0.1", port));
                match srv {
                    Ok(s) => {
                        let _ = tx.send(port as i32);
                        let _ = s.run().await;
                    }
                    Err(_) => {
                        let _ = tx.send(-1);
                    }
                }
            })
        })
        .expect("spawn static-server thread");
    rx.recv().unwrap_or(-1)
}

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "wasm" => "application/wasm",
        "json" => "application/json",
        "css" => "text/css",
        "gz" => "application/gzip",
        _ => "application/octet-stream",
    }
}

// --- In-process prover: the proof server's endpoints with no socket ---------------------

use actix_web::{App, test};
use std::sync::OnceLock;

struct ProverCall {
    method: String,
    path: String,
    body: Vec<u8>,
    reply: mpsc::Sender<(u16, Vec<u8>)>,
}

static PROVER: OnceLock<mpsc::Sender<ProverCall>> = OnceLock::new();

/// Starts the in-process prover on its own thread. `params_dir` is as for `mn_prover_start`.
/// Returns 0, or -1 if it could not start.
#[unsafe(no_mangle)]
pub extern "C" fn mn_inproc_start(params_dir: *const c_char, workers: u32) -> i32 {
    let dir = unsafe { CStr::from_ptr(params_dir) }.to_string_lossy().into_owned();
    // SAFETY: called once at app start, before any other thread reads the environment.
    unsafe { std::env::set_var("MIDNIGHT_PP", dir) };
    let (calls, inbox) = mpsc::channel::<ProverCall>();
    let (ready, started) = mpsc::channel();
    std::thread::Builder::new()
        .name("prover".into())
        .spawn(move || {
            actix_web::rt::System::new().block_on(async move {
                let pool = std::sync::Arc::new(midnight_proof_server::worker_pool::WorkerPool::new(workers as usize, 4, 600.0));
                let service = std::rc::Rc::new(
                    test::init_service(App::new().configure(|cfg| midnight_proof_server::configure(cfg, pool, false))).await,
                );
                let _ = ready.send(());
                // Calls are handled concurrently; the worker pool bounds the proving itself.
                let (forward, mut queue) = tokio::sync::mpsc::unbounded_channel::<ProverCall>();
                std::thread::spawn(move || {
                    for call in inbox {
                        if forward.send(call).is_err() {
                            break;
                        }
                    }
                });
                while let Some(call) = queue.recv().await {
                    let service = service.clone();
                    actix_web::rt::spawn(async move {
                        let request = match call.method.as_str() {
                            "GET" => test::TestRequest::get(),
                            _ => test::TestRequest::post(),
                        };
                        let request = request.uri(&call.path).set_payload(call.body).to_request();
                        let response = test::call_service(&*service, request).await;
                        let status = response.status().as_u16();
                        let body = test::read_body(response).await.to_vec();
                        let _ = call.reply.send((status, body));
                    });
                }
            })
        })
        .expect("spawn prover thread");
    if started.recv().is_err() {
        return -1;
    }
    if PROVER.set(calls).is_err() {
        return -1;
    }
    0
}

/// Makes one request to the in-process prover and blocks until it answers. The response
/// body is returned in `*out` (free it with `mn_free`). Returns the HTTP status, or -1.
#[unsafe(no_mangle)]
pub extern "C" fn mn_inproc_call(
    method: *const c_char,
    path: *const c_char,
    body: *const u8,
    body_len: usize,
    out: *mut *mut u8,
    out_len: *mut usize,
) -> i32 {
    let Some(prover) = PROVER.get() else { return -1 };
    let method = unsafe { CStr::from_ptr(method) }.to_string_lossy().into_owned();
    let path = unsafe { CStr::from_ptr(path) }.to_string_lossy().into_owned();
    let body = if body.is_null() || body_len == 0 { Vec::new() } else { unsafe { std::slice::from_raw_parts(body, body_len) }.to_vec() };
    let (reply, answer) = mpsc::channel();
    if prover.send(ProverCall { method, path, body, reply }).is_err() {
        return -1;
    }
    let Ok((status, bytes)) = answer.recv() else { return -1 };
    let boxed = bytes.into_boxed_slice();
    unsafe {
        *out_len = boxed.len();
        *out = Box::into_raw(boxed) as *mut u8;
    }
    status as i32
}

/// Frees a response body returned by `mn_inproc_call`.
#[unsafe(no_mangle)]
pub extern "C" fn mn_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) });
    }
}
