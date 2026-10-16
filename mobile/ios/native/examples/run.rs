fn main() {
    let a: Vec<String> = std::env::args().collect();
    let pp = std::ffi::CString::new(a[1].clone()).unwrap();
    let web = std::ffi::CString::new(a[2].clone()).unwrap();
    let prover = moth_native::mn_prover_start(pp.as_ptr(), 6300, 2);
    let stat = moth_native::mn_static_start(web.as_ptr(), 8765);
    println!("prover {prover} static {stat}");
    std::thread::sleep(std::time::Duration::from_secs(3600));
}
