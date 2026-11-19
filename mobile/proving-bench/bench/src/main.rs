use std::path::Path;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let ks = |s: &str| s.split(',').map(|x| x.parse().unwrap()).collect::<Vec<u8>>();
    match a.get(1).map(|s| s.as_str()) {
        Some("gen") => mn_mobile_bench::ksweep::generate(Path::new(&a[2]), Path::new(&a[3]), &ks(&a[4])),
        Some("sweep") => {
            let done = mn_mobile_bench::ksweep::run(Path::new(&a[2]), Path::new(&a[3]), &ks(&a[4]), a[5].parse().unwrap(), a[6].parse().unwrap(), Path::new(&a[7]));
            std::process::exit(if done { 0 } else { 3 });
        }
        Some("k") => {
            // Reads file paths on stdin; prints "k\trows\tpath" (or "ERR\t\tpath").
            use std::io::BufRead;
            for line in std::io::stdin().lock().lines() {
                let path = line.unwrap();
                match std::fs::File::open(&path).and_then(|f| zkir_v2::IrSource::load(f)) {
                    Ok(ir) => { let m = ir.model(); println!("{}\t{}\t{}", m.k(), m.rows(), path); }
                    Err(e) => println!("ERR\t{}\t{}", e.to_string().replace('\t', " "), path),
                }
            }
        }
        Some("calibrate") => for k in ks(&a[2]) { let n = mn_mobile_bench::ksweep::calibrate(k); println!("k={k} hashes={n} rows={}", mn_mobile_bench::ksweep::build_ir(n).model().rows()); },
        _ => {
            let dir = a.get(1).cloned().unwrap();
            let iters = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(3);
            let threads = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(6);
            println!("{}", mn_mobile_bench::run(&dir, iters, threads));
        }
    }
}
