//! JNI entry points for Moth on Android, over moth-native's C ABI (mobile/ios/native).
//! Each function maps to an `external fun` on `io.shielded.moth.Native`.
use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::jint;
use std::ffi::CString;

fn cstring(env: &mut JNIEnv, s: &JString) -> Option<CString> {
    let s: String = env.get_string(s).ok()?.into();
    CString::new(s).ok()
}

/// Starts the loopback proof server. Returns the bound port, or -1.
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_shielded_moth_Native_proverStart(
    mut env: JNIEnv,
    _class: JClass,
    params_dir: JString,
    port: jint,
    workers: jint,
) -> jint {
    let Some(dir) = cstring(&mut env, &params_dir) else { return -1 };
    moth_native::mn_prover_start(dir.as_ptr(), port as u16, workers as u32)
}

/// Serves the engine page from `dir` on 127.0.0.1:`port`. Returns the port, or -1.
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_shielded_moth_Native_staticStart(mut env: JNIEnv, _class: JClass, dir: JString, port: jint) -> jint {
    let Some(dir) = cstring(&mut env, &dir) else { return -1 };
    moth_native::mn_static_start(dir.as_ptr(), port as u16)
}
