import argparse
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("release", Path(__file__).with_name("native-publisher-release.py"))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_direct_rpc_fallback_does_not_accept_another_chain(self):
        with patch.dict(release.os.environ, {"ALCHEMY_API_KEY": "private-test-key"}):
            valid = io.BytesIO(json.dumps({"result": release.GENESIS}).encode())
            with patch.object(release.urllib.request, "urlopen", side_effect=[urllib.error.URLError("offline"), valid]) as call:
                release.check_genesis()
                self.assertEqual(call.call_args_list[1].args[0].full_url, "https://api.devnet.solana.com")
            invalid = io.BytesIO(json.dumps({"result": "another-chain"}).encode())
            with patch.object(release.urllib.request, "urlopen", return_value=invalid) as call:
                with self.assertRaisesRegex(ValueError, "genesis"):
                    release.check_genesis()
                self.assertEqual(call.call_count, 1)

    def configuration(self):
        target = 1_792_670_400
        config = {"schema": "relative.publisher/v1", "network": "solana-devnet", "enabled": False,
                  "first_epoch_opens_at": target, "basic_pool_id": 2, "anchor": {"timestamp_us": (target - 60) * 1_000_000}}
        intent = {"schema": "relative.activation-intent/v1", "network": "solana-devnet", "deployed": False,
                  "requiresReadinessBeforeArming": True, "targetUnixSeconds": target, "targetUtc": "2026-10-22T12:00:00Z",
                  "basicAdmission": "not configured onchain", "firstEpochOpening": "not configured onchain"}
        return config, intent, target - 120

    def test_admission_origin_and_unarmed_gates_fail_independently(self):
        config, intent, now = self.configuration()
        release.check_configuration(config, intent, now)
        changes = [("config", "enabled", True), ("config", "first_epoch_opens_at", intent["targetUnixSeconds"] + 14_400),
                   ("config", "basic_pool_id", 1), ("intent", "armed", True), ("intent", "deployed", True),
                   ("intent", "targetUtc", "2026-10-22T12:00:00+01:00"), ("intent", "targetUnixSeconds", intent["targetUnixSeconds"] + 1)]
        for which, key, value in changes:
            with self.subTest(key=key):
                changed_config, changed_intent = copy.deepcopy(config), copy.deepcopy(intent)
                (changed_config if which == "config" else changed_intent)[key] = value
                with self.assertRaises(ValueError):
                    release.check_configuration(changed_config, changed_intent, now)
        with self.assertRaises(ValueError):
            release.check_configuration(config, intent, intent["targetUnixSeconds"])
        config["anchor"]["timestamp_us"] = (intent["targetUnixSeconds"] + 1) * 1_000_000
        with self.assertRaises(ValueError):
            release.check_configuration(config, intent, now)

    def test_prepared_basic_postponement_preserves_epoch_boundaries_and_unarmed_state(self):
        config, intent, now = self.configuration()
        lower_bound = intent["targetUnixSeconds"]
        intent.update(poolAccountsPrepared=True, activationArmed=False, publisherEnabled=False,
                      basicOnchainAdmissionLowerBound=lower_bound,
                      targetUnixSeconds=lower_bound + 7200, targetUtc="2026-10-22T14:00:00Z",
                      firstEpochTargetUnixSeconds=lower_bound + 14400)
        config["first_epoch_opens_at"] = lower_bound + 14400
        release.check_configuration(config, intent, now)
        for key, value in [("activationArmed", True), ("publisherEnabled", True),
                           ("firstEpochTargetUnixSeconds", lower_bound + 7200),
                           ("basicOnchainAdmissionLowerBound", lower_bound + 7201)]:
            changed = copy.deepcopy(intent)
            changed[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                release.check_configuration(config, changed, now)

    def test_staging_copies_committed_allowlist_and_refuses_dirty_or_secret_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.email", "test@example.invalid"], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.name", "Test"], check=True)
            (root / "src").mkdir()
            (root / "src/main.rs").write_text("fn main() {}\n")
            (root / "Cargo.toml").write_text("fixture\n")
            (root / ".env").write_text("PRIVATE_FIXTURE=never-stage\n")
            subprocess.run(["git", "-C", str(root), "add", "Cargo.toml", "src"], check=True)
            subprocess.run(["git", "-C", str(root), "commit", "-qm", "fixture"], check=True)
            commit = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"]).decode().strip()
            artifact = root / "program.so"
            data = bytearray(64)
            data[:6] = b"\x7fELF\x02\x01"
            data[18:20] = (263).to_bytes(2, "little")
            artifact.write_bytes(data)
            args = argparse.Namespace(approved_commit=commit, basic_binary=artifact, epoch_binary=artifact,
                                      basic_sha256=release.sha(data), epoch_sha256=release.sha(data), output=root / "bundle")
            with patch.multiple(release, ROOT=root, SOURCE_FILES=["Cargo.toml"], SOURCE_DIRS=["src"]):
                release.stage(args)
                self.assertEqual(set(release.safe_bundle(args.output)["sources"]), {"Cargo.toml", "src/main.rs"})
                self.assertFalse((args.output / "context/.env").exists())
                (args.output / "context/private.env").write_text("unexpected")
                with self.assertRaisesRegex(ValueError, "Unexpected files"):
                    release.safe_bundle(args.output)
                (args.output / "context/private.env").unlink()
                (args.output / "context/src/main.rs").unlink()
                (args.output / "context/src/main.rs").symlink_to(root / ".env")
                with self.assertRaisesRegex(ValueError, "Symlinks"):
                    release.safe_bundle(args.output)
                (root / "src/main.rs").write_text("changed\n")
                with self.assertRaisesRegex(ValueError, "uncommitted"):
                    release.committed_sources(commit)
                subprocess.run(["git", "-C", str(root), "checkout", "--", "src/main.rs"], check=True)
                (root / "src/private.env").write_text("secret\n")
                with self.assertRaisesRegex(ValueError, "uncommitted"):
                    release.committed_sources(commit)

    def test_artifact_checks_reject_host_binaries_and_changed_review_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "binary"
            data = bytearray(64)
            data[:6] = b"\x7fELF\x02\x01"
            data[18:20] = (62).to_bytes(2, "little")
            binary.write_bytes(data)
            self.assertEqual(release.linux_binary(binary), release.sha(data))
            data[18:20] = (183).to_bytes(2, "little")
            binary.write_bytes(data)
            with self.assertRaises(ValueError):
                release.linux_binary(binary)
            args = argparse.Namespace(approved_commit="0" * 40, basic_binary=binary, epoch_binary=binary,
                                      basic_sha256="0" * 64, epoch_sha256="0" * 64, output=root / "bundle")
            with patch.object(release, "committed_sources", return_value={}):
                with self.assertRaisesRegex(ValueError, "Solana SBPF"):
                    release.stage(args)
                data[18:20] = (263).to_bytes(2, "little")
                binary.write_bytes(data)
                with self.assertRaisesRegex(ValueError, "reviewed SHA-256"):
                    release.stage(args)
                self.assertFalse(args.output.exists())


if __name__ == "__main__":
    unittest.main()
