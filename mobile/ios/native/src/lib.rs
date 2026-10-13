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
                match midnight_proof_server::server(port, false, pool) {
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
