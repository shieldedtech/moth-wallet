//! k sweep: synthetic circuits (a chain of transient_hash, i.e. Poseidon) sized to fill each k.
use rand::SeedableRng;
use rand::rngs::StdRng;
use serialize::{Deserializable, Serializable};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};
use transient_crypto::proofs::{PARAMS_VERIFIER, ParamsProver, ParamsProverProvider, ProverKey, VerifierKey, Zkir};
use zkir_v2::IrSource;

pub const PROOF_TIMEOUT: Duration = Duration::from_secs(60);

pub fn build_ir(n: usize) -> IrSource {
    let mut ins = Vec::with_capacity(n);
    for i in 0..n {
        let prev = if i == 0 { 0 } else { 1 + i };
        ins.push(format!(r#"{{"op":"transient_hash","inputs":[{prev},1]}}"#));
    }
    let raw = format!(r#"{{"version":{{"major":2,"minor":0}},"num_inputs":2,"do_communications_commitment":false,"instructions":[{}]}}"#, ins.join(","));
    IrSource::load(raw.as_bytes()).unwrap()
}

/// Largest chain length whose circuit still fits in 2^k rows.
/// Measured: rows = 22n + 2 and the usable rows are 2^k - 10, so start there and step down if needed.
pub fn calibrate(k: u8) -> usize {
    let mut n = ((1usize << k) - 12) / 22;
    while build_ir(n).model().k() > k { n -= 1; }
    n
}

pub struct DirParams { dir: PathBuf, cache: Mutex<HashMap<u8, ParamsProver>> }
impl DirParams { pub fn new(dir: &Path) -> Self { DirParams { dir: dir.into(), cache: Mutex::new(HashMap::new()) } } }
impl ParamsProverProvider for DirParams {
    async fn get_params(&self, k: u8) -> std::io::Result<ParamsProver> {
        if let Some(p) = self.cache.lock().unwrap().get(&k) { return Ok(p.clone()); }
        let p = ParamsProver::read(BufReader::new(File::open(self.dir.join(format!("bls_midnight_2p{k}")))?))?;
        self.cache.lock().unwrap().insert(k, p.clone());
        Ok(p)
    }
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
}

/// Mac-side: calibrate, keygen and write k{k}.ir / .pk / .vk into `out`.
pub fn generate(params_dir: &Path, out: &Path, ks: &[u8]) {
    fs::create_dir_all(out).unwrap();
    let params = DirParams::new(params_dir);
    for &k in ks {
        let n = calibrate(k);
        let ir = build_ir(n);
        let t = Instant::now();
        let (pk, vk) = block_on(ir.keygen(&params)).unwrap();
        let keygen_s = t.elapsed().as_secs_f64();
        let mut b = vec![]; Serializable::serialize(&ir, &mut b).unwrap(); fs::write(out.join(format!("k{k}.ir")), &b).unwrap();
        let mut b = vec![]; Serializable::serialize(&pk, &mut b).unwrap(); let pk_len = b.len(); fs::write(out.join(format!("k{k}.pk")), &b).unwrap();
        let mut b = vec![]; Serializable::serialize(&vk, &mut b).unwrap(); fs::write(out.join(format!("k{k}.vk")), &b).unwrap();
        println!("{}", serde_json::json!({"k": k, "hashes": n, "rows": ir.model().rows(), "keygen_s": keygen_s, "pk_mb": pk_len as f64 / 1048576.0}));
    }
}

fn append(out: &Path, v: serde_json::Value) {
    let mut f = OpenOptions::new().create(true).append(true).open(out).unwrap();
    writeln!(f, "{v}").unwrap();
    f.sync_all().ok();
}

/// Device-side: for each k, load keys, prove `rounds` times, verify. Appends one JSON line per event to `out`.
/// Returns false if a proof exceeded PROOF_TIMEOUT (caller should exit the process: the proving thread can't be stopped).
pub fn run(params_dir: &Path, keys_dir: &Path, ks: &[u8], rounds: u32, threads: usize, out: &Path) -> bool {
    let params = Arc::new(DirParams::new(params_dir));
    for &k in ks {
        let read = |ext: &str| fs::read(keys_dir.join(format!("k{k}.{ext}"))).unwrap();
        let t = Instant::now();
        let ir: IrSource = Deserializable::deserialize(&mut &read("ir")[..], 0).unwrap();
        let pk: ProverKey<IrSource> = Deserializable::deserialize(&mut &read("pk")[..], 0).unwrap();
        let vk: VerifierKey = Deserializable::deserialize(&mut &read("vk")[..], 0).unwrap();
        let read_s = t.elapsed().as_secs_f64();
        let t = Instant::now();
        pk.init().unwrap();
        let init_s = t.elapsed().as_secs_f64();
        let t = Instant::now();
        block_on(params.get_params(k)).unwrap();
        let srs_s = t.elapsed().as_secs_f64();
        append(out, serde_json::json!({"event": "loaded", "k": k, "threads": threads, "read_s": read_s, "pk_init_s": init_s, "srs_load_s": srs_s,
            "phys_footprint_mb": crate::phys_footprint_mb().0, "phys_footprint_peak_mb": crate::phys_footprint_mb().1}));
        let ir = Arc::new(ir);
        for r in 0..rounds {
            let (tx, rx) = mpsc::channel();
            let (ir2, pk2, params2) = (ir.clone(), pk.clone(), params.clone());
            std::thread::spawn(move || {
                let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
                let res = pool.install(|| {
                    let pre = transient_crypto::proofs::ProofPreimage {
                        binding_input: 42.into(), communications_commitment: None,
                        inputs: vec![7.into(), 1.into()], private_transcript: vec![],
                        public_transcript_inputs: vec![], public_transcript_outputs: vec![],
                        key_location: transient_crypto::proofs::KeyLocation(std::borrow::Cow::Borrowed("ksweep")),
                    };
                    let t = Instant::now();
                    let res = block_on(ir2.prove(StdRng::seed_from_u64(r as u64), &*params2, pk2, &pre));
                    (t.elapsed().as_secs_f64(), res.map(|(p, pis, _)| (p, pis)))
                });
                let _ = tx.send(res);
            });
            match rx.recv_timeout(PROOF_TIMEOUT) {
                Ok((prove_s, Ok((proof, pis)))) => {
                    let t = Instant::now();
                    let ok = vk.verify(&PARAMS_VERIFIER, &proof, pis.into_iter()).is_ok();
                    append(out, serde_json::json!({"event": "proof", "k": k, "round": r, "threads": threads, "prove_s": prove_s,
                        "verify_s": t.elapsed().as_secs_f64(), "verified": ok,
                        "phys_footprint_mb": crate::phys_footprint_mb().0, "phys_footprint_peak_mb": crate::phys_footprint_mb().1}));
                }
                Ok((_, Err(e))) => append(out, serde_json::json!({"event": "error", "k": k, "round": r, "error": format!("{e:?}")})),
                Err(_) => {
                    append(out, serde_json::json!({"event": "timeout", "k": k, "round": r, "threads": threads, "limit_s": PROOF_TIMEOUT.as_secs(),
                        "phys_footprint_peak_mb": crate::phys_footprint_mb().1}));
                    return false;
                }
            }
        }
        drop(pk);
    }
    true
}
