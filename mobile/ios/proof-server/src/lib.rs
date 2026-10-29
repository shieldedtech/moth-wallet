// This file is part of midnight-ledger.
// Copyright (C) Midnight Foundation
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0 (the "License");
// You may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#![deny(unreachable_pub)]
#![deny(warnings)]
use actix_cors::Cors;
use actix_web::dev::Server;
use actix_web::middleware::Logger;
use actix_web::web::{self, Data};
use actix_web::{App, HttpServer};
use std::sync::Arc;

use crate::endpoints::{
    check, fetch_k, get_k, health, proof_versions, prove, prove_transaction, ready, version,
};
use crate::worker_pool::WorkerPool;

pub mod endpoints;
pub mod versioned_ir;
pub mod worker_pool;

/// Registers the endpoints; shared by `server` and hosts that call them in-process.
pub fn configure(cfg: &mut web::ServiceConfig, pool: Arc<WorkerPool>, fetch_params: bool) {
    cfg.app_data(Data::new(pool))
        .service(prove_transaction)
        .service(prove)
        .service(check)
        .service(get_k)
        .service(version)
        .service(proof_versions)
        .service(ready)
        .route("/", web::get().to(health))
        .route("/health", web::get().to(health));
    if fetch_params {
        cfg.service(fetch_k);
    }
}

/// The origin of Moth's engine page (`EngineScheme`), the only browser origin the app's
/// prover answers.
pub const ENGINE_ORIGIN: &str = "moth://engine";

/// Modified for moth mobile: upstream wraps `Cors::permissive()`, which lets any page in
/// Moth's DApp browser that can reach loopback (an http page on localhost) read and call the
/// prover. Only `allowed_origins` get CORS headers, and a request carrying any other `Origin`
/// is refused before a handler runs: CORS alone would still execute a simple POST. Requests
/// with no `Origin` (non-browser clients) are served as before.
fn cors(allowed_origins: &[String]) -> Cors {
    allowed_origins.iter().fold(
        Cors::default()
            .allow_any_method()
            .allow_any_header()
            .block_on_origin_mismatch(true),
        |cors, origin| cors.allowed_origin(origin),
    )
}

pub fn server(
    port: u16,
    fetch_params: bool,
    pool: WorkerPool,
    allowed_origins: &[&str],
) -> std::io::Result<(Server, u16)> {
    let pool = Arc::new(pool);
    let allowed_origins: Vec<String> = allowed_origins.iter().map(|o| o.to_string()).collect();
    let http_server = HttpServer::new(move || {
        App::new()
            .configure(|cfg| configure(cfg, pool.clone(), fetch_params))
            .wrap(Logger::new("%a %r; took %Ts"))
            .wrap(cors(&allowed_origins))
    })
    // Modified for moth mobile: loopback only (upstream binds 0.0.0.0).
    .bind(("127.0.0.1", port))?;
    let port = http_server.addrs()[0].port();
    let srv = http_server.run();
    Ok((srv, port))
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::http::{Method, StatusCode, header};
    use actix_web::{HttpResponse, test};

    async fn call(
        origin: Option<&str>,
        method: Method,
    ) -> actix_web::dev::ServiceResponse<impl actix_web::body::MessageBody> {
        let app = test::init_service(
            App::new()
                .route("/check", web::post().to(HttpResponse::Ok))
                .wrap(cors(&[ENGINE_ORIGIN.to_string()])),
        )
        .await;
        let mut req = test::TestRequest::default().method(method).uri("/check");
        if let Some(origin) = origin {
            req = req.insert_header((header::ORIGIN, origin));
        }
        test::call_service(&app, req.to_request()).await
    }

    #[actix_web::test]
    async fn a_foreign_origin_is_refused_before_the_handler() {
        // A simple POST needs no preflight, so the server itself must refuse it.
        let res = call(Some("http://127.0.0.1:5175"), Method::POST).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert!(
            !res.headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        );
    }

    #[actix_web::test]
    async fn the_engine_origin_is_served_with_cors_headers() {
        let res = call(Some(ENGINE_ORIGIN), Method::POST).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            ENGINE_ORIGIN
        );
    }

    #[actix_web::test]
    async fn a_request_without_an_origin_is_served() {
        assert_eq!(call(None, Method::POST).await.status(), StatusCode::OK);
    }

    #[actix_web::test]
    async fn a_foreign_preflight_gets_no_permission() {
        let app = test::init_service(
            App::new()
                .route("/check", web::post().to(HttpResponse::Ok))
                .wrap(cors(&[ENGINE_ORIGIN.to_string()])),
        )
        .await;
        let req = test::TestRequest::default()
            .method(Method::OPTIONS)
            .uri("/check")
            .insert_header((header::ORIGIN, "http://127.0.0.1:5175"))
            .insert_header((header::ACCESS_CONTROL_REQUEST_METHOD, "POST"))
            .to_request();
        let res = test::call_service(&app, req).await;
        assert!(
            !res.headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        );
    }
}
