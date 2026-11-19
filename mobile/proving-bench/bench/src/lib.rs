//! On-device proving benchmark: one shielded output and one shielded spend, ledger 8.1.3.
pub mod ksweep;
use base_crypto::data_provider::{self, MidnightDataProvider};
use base_crypto::rng::SplittableRng;
use coin_structure::coin::Info as CoinInfo;
use midnight_zswap::keys::SecretKeys;
use midnight_zswap::local::State as ZswapLocalState;
use midnight_zswap::prove::ZswapResolver;
use midnight_zswap::{Delta, Offer, Output as ZswapOutput, ZSWAP_EXPECTED_FILES};
use rand::SeedableRng;
use rand::rngs::StdRng;
use std::ffi::{CStr, CString, c_char};
use std::time::Instant;
use storage::db::InMemoryDB;
use transient_crypto::proofs::{Proof, ProofPreimage};
use zkir_v2::LocalProvingProvider;

fn prove(offer: &Offer<ProofPreimage, InMemoryDB>, rng: StdRng, r: &ZswapResolver) -> Offer<Proof, InMemoryDB> {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let provider = LocalProvingProvider { rng, params: r, resolver: r };
    rt.block_on(async { offer.clone().prove(provider, 0).await.unwrap().1 })
}

#[cfg(target_vendor = "apple")]
pub fn phys_footprint_mb() -> (f64, f64) {
    // task_vm_info.phys_footprint: what iOS jetsam counts against the app.
    #[repr(C)]
    struct TaskVmInfo { _pad: [u64; 18], phys_footprint: u64, _min: u64, _max: u64, phys_footprint_peak: u64, _rest: [u64; 40] }
    unsafe extern "C" { fn mach_task_self() -> u32; fn task_info(t: u32, f: i32, i: *mut TaskVmInfo, c: *mut u32) -> i32; }
    let mut info: TaskVmInfo = unsafe { std::mem::zeroed() };
    let mut count = (std::mem::size_of::<TaskVmInfo>() / 4) as u32;
    let kr = unsafe { task_info(mach_task_self(), 22, &mut info, &mut count) };
    if kr == 0 { (info.phys_footprint as f64 / 1048576.0, info.phys_footprint_peak as f64 / 1048576.0) } else { (-1.0, -1.0) }
}
#[cfg(not(target_vendor = "apple"))]
pub fn phys_footprint_mb() -> (f64, f64) { (-1.0, -1.0) }

fn max_rss_mb() -> f64 {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
    // ru_maxrss is bytes on Apple, KiB on Linux/Android.
    if cfg!(target_vendor = "apple") { ru.ru_maxrss as f64 / 1048576.0 } else { ru.ru_maxrss as f64 / 1024.0 }
}

/// Runs `iterations` rounds of (prove output, prove spend). Returns JSON.
pub fn run(params_dir: &str, iterations: u32, threads: usize) -> String {
    unsafe { std::env::set_var("MIDNIGHT_PP", params_dir) };
    let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
    let mem_start = phys_footprint_mb().0;
    let t0 = Instant::now();
    pool.install(|| {
        let t_load = Instant::now();
        let resolver = ZswapResolver(MidnightDataProvider::new(
            data_provider::FetchMode::Synchronous, data_provider::OutputMode::Log, ZSWAP_EXPECTED_FILES.to_owned(),
        ).unwrap());
        let mem_after_resolver = phys_footprint_mb().0;
        let mut rng = StdRng::seed_from_u64(0x42);
        let keys = SecretKeys::from_rng_seed(&mut rng);
        let mut rounds = vec![];
        let mut first = true;
        for _ in 0..iterations {
            let coin = CoinInfo::new(&mut rng, 5_000_000_000u128, Default::default());
            let out = ZswapOutput::new(&mut rng, &coin, None, &keys.coin_public_key(), None).unwrap();
            let offer = Offer {
                inputs: storage::storage::Array::new(), outputs: vec![out].into(), transient: storage::storage::Array::new(),
                deltas: vec![Delta { token_type: Default::default(), value: -(5_000_000_000i128) }].into(),
            };
            let t = Instant::now();
            let proven = prove(&offer, rng.split(), &resolver);
            let output_s = t.elapsed().as_secs_f64();
            let (mem_after_output, peak_after_output) = phys_footprint_mb();
            let load_s = if first { first = false; Some(t_load.elapsed().as_secs_f64()) } else { None };

            let local = ZswapLocalState::<InMemoryDB>::new().watch_for(&keys.coin_public_key(), &coin).apply(&keys, &proven).unwrap();
            let qc = local.coins.iter().next().unwrap().1;
            let (_, input) = local.spend(&mut rng, &keys, &qc, None).unwrap();
            let offer = Offer {
                inputs: vec![input].into(), outputs: storage::storage::Array::new(), transient: storage::storage::Array::new(),
                deltas: vec![Delta { token_type: coin.type_, value: 5_000_000_000i128 }].into(),
            };
            let t = Instant::now();
            let spent = prove(&offer, rng.split(), &resolver);
            let spend_s = t.elapsed().as_secs_f64();
            spent.well_formed(0).expect("spend proof must verify");
            rounds.push(serde_json::json!({
                "t_end_s": t0.elapsed().as_secs_f64(), "output_s": output_s, "mem_after_output_mb": mem_after_output, "peak_after_output_mb": peak_after_output, "spend_s": spend_s, "first_round_incl_load_s": load_s,
                "phys_footprint_mb": phys_footprint_mb().0, "phys_footprint_peak_mb": phys_footprint_mb().1, "max_rss_mb": max_rss_mb(),
            }));
        }
        serde_json::json!({ "mem_start_mb": mem_start, "mem_after_resolver_mb": mem_after_resolver, "ledger": "8.1.3", "threads": threads, "rounds": rounds }).to_string()
    })
}

/// C ABI for the iOS harness. Caller frees with `mn_bench_free`.
#[unsafe(no_mangle)]
pub extern "C" fn mn_bench_run(params_dir: *const c_char, iterations: u32, threads: u32) -> *mut c_char {
    let dir = unsafe { CStr::from_ptr(params_dir) }.to_string_lossy().into_owned();
    let out = std::panic::catch_unwind(|| run(&dir, iterations, threads as usize))
        .unwrap_or_else(|_| "{\"error\":\"panic\"}".to_owned());
    CString::new(out).unwrap().into_raw()
}

#[unsafe(no_mangle)]
pub extern "C" fn mn_bench_free(s: *mut c_char) {
    if !s.is_null() { unsafe { drop(CString::from_raw(s)) } }
}

/// C ABI: k sweep. `ks` is comma-separated. Returns 1 if completed, 0 if a proof timed out (caller should exit).
#[unsafe(no_mangle)]
pub extern "C" fn mn_ksweep_run(params_dir: *const c_char, keys_dir: *const c_char, ks: *const c_char, rounds: u32, threads: u32, out: *const c_char) -> i32 {
    let s = |p: *const c_char| unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
    let ks: Vec<u8> = s(ks).split(',').filter_map(|x| x.trim().parse().ok()).collect();
    ksweep::run(std::path::Path::new(&s(params_dir)), std::path::Path::new(&s(keys_dir)), &ks, rounds, threads as usize, std::path::Path::new(&s(out))) as i32
}
