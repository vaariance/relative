use relative_methodology::{
    inclusion::*,
    transition::{self, Binding, OriginalReference, Request},
};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    directory: PathBuf,
    request: Request,
}
impl Fixture {
    fn new() -> Self {
        let directory = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "relative-inclusion-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&directory).unwrap();
        let policy = InclusionPolicy {
            minimum_notice_seconds: 100,
            validation_max_age_seconds: 100_000,
            max_assets: 256,
        };
        let scheduled = |index: u32, at: u64| {
            let definition = AssetDefinition {
                stable_asset_id: format!("asset-{index}"),
                token_mint: format!("{}{}", "1".repeat(31), index + 2),
                exposure_group: format!("underlying-{index}"),
                feed: FeedIdentity::Pro {
                    price_feed_id: u64::from(index + 1),
                },
            };
            let evidence = ValidationEvidence {
                asset_digest: asset_identity_digest(&definition).unwrap(),
                source_authority: "provider".into(),
                source_fact_digest: "a".repeat(64),
                assessment_digest: "b".repeat(64),
                checked_at: 0,
                valid_until: 100_000,
            };
            schedule_asset(
                approve_asset(
                    validate_candidate(candidate_asset(definition).unwrap(), evidence, 0, &policy)
                        .unwrap(),
                    "2".repeat(32),
                    0,
                    &policy,
                )
                .unwrap(),
                at,
                100,
                &policy,
            )
            .unwrap()
        };
        let previous = activate_universe(
            None,
            &[scheduled(0, 14_400), scheduled(1, 14_400)],
            14_400,
            &policy,
        )
        .unwrap();
        let next =
            activate_universe(Some(&previous), &[scheduled(2, 28_800)], 28_800, &policy).unwrap();
        let binding = |index: u16| Binding {
            stable_asset_id: format!("asset-{index}"),
            runtime_asset_id: format!("ASSET{index}"),
            pro_feed_id: u32::from(index + 1),
            basic_class_id: index,
            epoch_asset_id: index,
            epoch_feed_id: [index as u8 + 1; 32],
            original_reference: (index < 2).then_some(OriginalReference {
                timestamp_us: 14_400_000_000,
                price_e8: 123,
                benchmark: 100_000_000_000_000,
            }),
        };
        let request = Request {
            schema: "relative.inclusion-request/v1".into(),
            previous,
            next,
            previous_bindings: (0..2).map(binding).collect(),
            next_bindings: (0..3).map(binding).collect(),
        };
        Self { directory, request }
    }
    fn input(&self) -> PathBuf {
        self.directory.join("request.json")
    }
    fn output(&self) -> PathBuf {
        self.directory.join("prepared.json")
    }
    fn save(&self) {
        fs::write(self.input(), serde_json::to_vec(&self.request).unwrap()).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}
#[test]
fn cli_prepares_an_immutable_nonactivating_artifact_and_never_overwrites() {
    let fixture = Fixture::new();
    fixture.save();
    let before = fs::read(fixture.input()).unwrap();
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_relative-publisher"))
            .args(["prepare-inclusion", "--request"])
            .arg(fixture.input())
            .arg("--output")
            .arg(fixture.output())
            .output()
            .unwrap()
    };
    let result = run();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["activated"], false);
    assert_eq!(report["prepared"], true);
    assert_eq!(report["blockers"].as_array().unwrap().len(), 4);
    let prepared = fs::read(fixture.output()).unwrap();
    let artifact: transition::Preparation = serde_json::from_slice(&prepared).unwrap();
    transition::validate(&artifact).unwrap();
    assert_eq!(artifact.request, fixture.request);
    assert_eq!(before, fs::read(fixture.input()).unwrap());
    assert!(!run().status.success());
    assert_eq!(prepared, fs::read(fixture.output()).unwrap());
    assert_eq!(fs::read_dir(&fixture.directory).unwrap().count(), 2);
}
#[test]
fn invalid_or_unknown_fields_cannot_create_preparation_artifacts() {
    let mut fixture = Fixture::new();
    fixture.request.next_bindings[0]
        .original_reference
        .as_mut()
        .unwrap()
        .price_e8 += 1;
    fixture.save();
    assert_eq!(
        relative_publisher::preparation::prepare(&fixture.input(), &fixture.output()),
        Err(relative_publisher::preparation::Error::InvalidTransition)
    );
    assert!(!fixture.output().exists());
    let mut json = serde_json::to_value(&fixture.request).unwrap();
    json["activate"] = true.into();
    fs::write(fixture.input(), serde_json::to_vec(&json).unwrap()).unwrap();
    assert_eq!(
        relative_publisher::preparation::prepare(&fixture.input(), &fixture.output()),
        Err(relative_publisher::preparation::Error::InvalidRequest)
    );
    assert!(!fixture.output().exists());
}
#[cfg(unix)]
#[test]
fn symlinked_requests_and_output_directories_fail_closed() {
    let fixture = Fixture::new();
    fixture.save();
    let symlink = fixture.directory.join("linked.json");
    std::os::unix::fs::symlink(fixture.input(), &symlink).unwrap();
    assert_eq!(
        relative_publisher::preparation::prepare(&symlink, &fixture.output()),
        Err(relative_publisher::preparation::Error::UnsafePath)
    );
    let directory_link = fixture.directory.join("linked");
    std::os::unix::fs::symlink(&fixture.directory, &directory_link).unwrap();
    assert_eq!(
        relative_publisher::preparation::prepare(
            &fixture.input(),
            &directory_link.join("output.json")
        ),
        Err(relative_publisher::preparation::Error::UnsafePath)
    );
}
