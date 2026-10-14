//! Calls the in-process prover's endpoints on a Mac: cargo run --release --example inproc -- <zk-params-dir>
use std::ffi::CString;

fn call(method: &str, path: &str) -> (i32, String) {
    let (m, p) = (CString::new(method).unwrap(), CString::new(path).unwrap());
    let (mut out, mut len) = (std::ptr::null_mut(), 0usize);
    let status = moth_native::mn_inproc_call(m.as_ptr(), p.as_ptr(), std::ptr::null(), 0, &mut out, &mut len);
    let body = unsafe { String::from_utf8_lossy(std::slice::from_raw_parts(out, len)).into_owned() };
    moth_native::mn_free(out, len);
    (status, body)
}

fn main() {
    let pp = CString::new(std::env::args().nth(1).expect("zk params dir")).unwrap();
    assert_eq!(moth_native::mn_inproc_start(pp.as_ptr(), 2), 0);
    println!("{:?}", call("GET", "/version"));
    println!("{:?}", call("GET", "/ready"));
}
