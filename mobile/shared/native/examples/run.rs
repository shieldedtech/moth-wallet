fn main() {
    let a: Vec<String> = std::env::args().collect();
    let pp = std::ffi::CString::new(a[1].clone()).unwrap();
    let web = std::ffi::CString::new(a[2].clone()).unwrap();
    // The page below is served from http://127.0.0.1:8765; let it call the prover.
    // SAFETY: no other thread has started yet.
    unsafe { std::env::set_var("MOTH_PROVER_DEV_ORIGIN", "http://127.0.0.1:8765") };
    let prover = moth_native::mn_prover_start(pp.as_ptr(), 6300, 2);
    let stat = moth_native::mn_static_start(web.as_ptr(), 8765);
    println!("prover {prover} static {stat}");
    std::thread::sleep(std::time::Duration::from_secs(3600));
}
