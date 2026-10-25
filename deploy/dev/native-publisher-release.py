import argparse
import datetime
import hashlib
import grp
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = "apps/cox-publisher/native/Dockerfile"
SOURCE_FILES = [
    DOCKERFILE,
    "deploy/dev/native-publisher-release.py",
    "apps/cox-publisher/native/Cargo.toml",
    "apps/cox-publisher/native/Cargo.lock",
    "packages/cox/programs/cox/Cargo.toml",
    "packages/cox/crates/math/Cargo.toml",
    "packages/cox-epoch/Cargo.toml",
    "packages/cox-epoch/programs/epoch/Cargo.toml",
    "packages/cox-methodology/rust/Cargo.toml",
    "packages/cox/idl/cox.json",
    "packages/cox-epoch/idl/epoch.json",
    "packages/cox/deploy/devnet.json",
    "packages/cox-epoch/deploy/devnet.json",
]
SOURCE_DIRS = [
    "apps/cox-publisher/native/src",
    "packages/cox/programs/cox/src",
    "packages/cox/crates/math/src",
    "packages/cox-epoch/src",
    "packages/cox-epoch/programs/epoch/src",
    "packages/cox-methodology/rust/src",
]
GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
SCHEMA = "relative.native-release/v1"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def replace_service_configuration(source, destination, uid, gid):
    require(source.is_file() and not source.is_symlink(), "Configuration source must be a regular file")
    require(not destination.is_symlink() and destination.parent.is_dir()
            and not destination.parent.is_symlink(), "Unsafe configuration destination")
    payload = source.read_bytes()
    config = json.loads(payload)
    expected = {"native.json": {"relative.publisher/v1"},
                "native-backup.json": {"relative.backup/v1", "relative.backup/v2"}}
    require(destination.name in expected and config.get("schema") in expected[destination.name],
            "Configuration name or schema mismatch")
    if config.get("schema") == "relative.backup/v2":
        runtime_path = config.get("runtime_config_path")
        require(isinstance(runtime_path, str) and Path(runtime_path).is_absolute(),
                "Generation-bound backup requires an absolute runtime configuration path")
    fd, temporary = tempfile.mkstemp(prefix="." + destination.name + ".", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            os.fchmod(output.fileno(), 0o640)
            os.fchown(output.fileno(), uid, gid)
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
        directory = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install_config(args):
    require(os.geteuid() == 0 and args.destination.parent == Path("/etc/cox-publisher"),
            "Configuration installation requires root and the publisher configuration directory")
    replace_service_configuration(args.source, args.destination, 0, grp.getgrnam("cox-publisher").gr_gid)
    print(json.dumps({"installed": True, "owner": "root:cox-publisher", "mode": "0640"}))


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args], stderr=subprocess.DEVNULL)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    require(path.is_file() and not path.is_symlink(), "Expected a regular JSON file")
    require(path.stat().st_size <= 1_048_576, "JSON file exceeds size limit")
    return json.loads(path.read_text())


def committed_sources(commit):
    require(re.fullmatch(r"[0-9a-f]{40}", commit) is not None, "Use the full approved commit SHA")
    require(git("rev-parse", "HEAD").decode().strip() == commit, "HEAD differs from approved commit")
    scopes = SOURCE_FILES + SOURCE_DIRS
    require(not git("status", "--porcelain", "--untracked-files=all", "--", *scopes).strip(),
            "Release source is uncommitted or differs from the approved commit")
    files = set(git("ls-files", "-z", "--", *scopes).decode().split("\0")) - {""}
    require(set(SOURCE_FILES).issubset(files), "Release source files must all be committed")
    result = {}
    for name in sorted(files):
        require(name in SOURCE_FILES or name.endswith(".rs"), "Unexpected non-source file in release inputs")
        path = ROOT / name
        require(path.is_file() and not path.is_symlink(), "Release inputs must be regular files")
        blob = git("show", f"{commit}:{name}")
        require(blob == path.read_bytes(), "Release source differs from its committed bytes")
        result[name] = sha(blob)
    return result


def safe_bundle(path):
    require(path.is_dir() and not path.is_symlink(), "Expected a regular release directory")
    manifest = read_json(path / "release.json")
    require(manifest.get("schema") == SCHEMA, "Unsupported release manifest")
    sources = committed_sources(manifest["commit"])
    require(sources == manifest["sources"], "Committed release source hashes differ")
    context = path / "context"
    require(context.is_dir() and not context.is_symlink(), "Expected a regular build context")
    expected = set(sources)
    actual = set()
    for staged in context.rglob("*"):
        require(not staged.is_symlink(), "Symlinks are not allowed in the build context")
        if staged.is_file():
            actual.add(staged.relative_to(context).as_posix())
    require(actual == expected, "Unexpected files in the build context")
    for name, digest in sources.items():
        staged = context / name
        require(staged.is_file() and sha(staged.read_bytes()) == digest, "Staged source hash mismatch")
    require(set(manifest["artifacts"]) == {"basic.so", "epoch.so"}, "Both contract artifacts are required")
    for name, digest in manifest["artifacts"].items():
        require(name in {"basic.so", "epoch.so"}, "Unexpected contract artifact")
        artifact = path / name
        require(artifact.is_file() and not artifact.is_symlink() and sha(artifact.read_bytes()) == digest,
                "Contract artifact hash mismatch")
    return manifest


def stage(args):
    sources = committed_sources(args.approved_commit)
    require(not args.output.exists(), "Release output already exists")
    artifacts = {}
    for name, source, reviewed in [("basic.so", args.basic_binary, args.basic_sha256), ("epoch.so", args.epoch_binary, args.epoch_sha256)]:
        require(source.is_file() and not source.is_symlink(), "Expected a regular compiled contract")
        data = source.read_bytes()
        require(len(data) >= 64 and data[:6] == b"\x7fELF\x02\x01" and int.from_bytes(data[18:20], "little") == 263,
                "Contract artifact must be ELF64 little-endian Solana SBPF")
        require(re.fullmatch(r"[0-9a-f]{64}", reviewed) is not None and sha(data) == reviewed,
                "Contract artifact differs from explicitly reviewed SHA-256")
        artifacts[name] = data
    args.output.mkdir(parents=True, mode=0o700)
    for name in sources:
        target = args.output / "context" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(git("show", f"{args.approved_commit}:{name}"))
    for name, data in artifacts.items():
        (args.output / name).write_bytes(data)
    manifest = {"schema": SCHEMA, "commit": args.approved_commit, "sources": sources,
                "sourceDateEpoch": int(git("show", "-s", "--format=%ct", args.approved_commit)),
                "artifacts": {name: sha(data) for name, data in artifacts.items()},
                "linux": None, "contractBuildProvenanceVerified": False, "deploymentAuthorized": False}
    (args.output / "release.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Committed source and contract artifacts staged; no build or deployment performed")


def linux_binary(path):
    require(path.is_file() and not path.is_symlink(), "Linux executable is missing")
    data = path.read_bytes()
    require(len(data) >= 64 and data[:6] == b"\x7fELF\x02\x01" and int.from_bytes(data[18:20], "little") == 62,
            "Publisher executable must be ELF64 little-endian x86-64 for linux/amd64")
    return sha(data)


def build(args):
    manifest = safe_bundle(args.bundle)
    require(manifest["linux"] is None, "Linux build already recorded; stage a new release")
    for image in [args.rust_image, args.runtime_image]:
        require(re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}", image) is not None,
                "Builder and runtime images must be pinned by SHA-256 digest")
    subprocess.run(["docker", "version", "--format", "{{.Server.Version}}"], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    common = ["docker", "buildx", "build", "--platform", "linux/amd64", "--file", str(args.bundle / "context" / DOCKERFILE),
              "--build-arg", f"RUST_IMAGE={args.rust_image}", "--build-arg", f"RUNTIME_IMAGE={args.runtime_image}",
              "--build-arg", f"SOURCE_DATE_EPOCH={manifest['sourceDateEpoch']}"]
    output = args.bundle / "linux"
    require(not output.exists(), "Linux output directory already exists")
    subprocess.run(common + ["--target", "artifact", "--output", f"type=local,dest={output}", str(args.bundle / "context")], check=True)
    digest = linux_binary(output / "relative-publisher")
    manifest["linux"] = {"platform": "linux/amd64", "sha256": digest, "rustImage": args.rust_image,
                         "runtimeImage": args.runtime_image, "rustVersion": "1.90.0"}
    (args.bundle / "release.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"linuxSha256": digest, "deploymentAuthorized": False}))


def check_configuration(config, intent, now):
    require(config.get("schema") == "relative.publisher/v1" and config.get("network") == "solana-devnet"
            and config.get("enabled") is False, "Native configuration must explicitly be disabled on devnet")
    require(intent.get("schema") == "relative.activation-intent/v1" and intent.get("network") == "solana-devnet"
            and intent.get("deployed") is False and intent.get("armed", False) is False
            and intent.get("requiresReadinessBeforeArming") is True, "Activation intent must remain unarmed")
    prepared = intent.get("poolAccountsPrepared", False)
    require(type(prepared) is bool, "Prepared-account state must be explicit")
    if prepared:
        require(intent.get("activationArmed") is False and intent.get("publisherEnabled") is False,
                "Prepared activation must remain unarmed with the publisher disabled")
    else:
        require(intent.get("basicAdmission") == "not configured onchain"
                and intent.get("firstEpochOpening") == "not configured onchain", "Activation must remain unconfigured")
    target = intent.get("targetUnixSeconds")
    require(type(target) is int and target > now, "Activation target must be in the future")
    stated = datetime.datetime.fromisoformat(intent["targetUtc"].replace("Z", "+00:00"))
    require(stated.utcoffset() == datetime.timedelta(0) and stated.timestamp() == target, "Activation UTC text and timestamp differ")
    epoch_target = intent.get("firstEpochTargetUnixSeconds", target)
    require(type(epoch_target) is int and epoch_target >= target and epoch_target % 14_400 == 0,
            "First Epoch must use a four-hour UTC boundary at or after activation")
    require(config.get("first_epoch_opens_at") == epoch_target, "Native first Epoch opening differs from activation intent")
    if prepared:
        lower_bound = intent.get("basicOnchainAdmissionLowerBound")
        require(type(lower_bound) is int and 0 < lower_bound <= target,
                "Prepared Basic admission lower bound must precede actual activation")
    require(config.get("basic_pool_id") != 1 and type(config.get("basic_pool_id")) is int, "Retired pool 1 cannot be reused")
    anchor_us = config.get("anchor", {}).get("timestamp_us")
    require(type(anchor_us) is int and anchor_us > 0 and anchor_us % 1_000_000 == 0
            and anchor_us // 1_000_000 <= target, "Benchmark origin must precede scheduled admission")


def check_genesis():
    key = os.environ.get("ALCHEMY_API_KEY")
    require(key and not any(character.isspace() for character in key), "ALCHEMY_API_KEY is required privately")
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "getGenesisHash", "params": []}).encode()
    for url in [f"https://solana-devnet.g.alchemy.com/v2/{key}", "https://api.devnet.solana.com"]:
        try:
            request = urllib.request.Request(url, payload, {"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=15) as response:
                result = json.loads(response.read(16_384))
        except (urllib.error.URLError, TimeoutError, ValueError):
            continue
        require(result.get("result") == GENESIS, "RPC genesis does not match Solana devnet")
        return
    raise ValueError("Both direct devnet RPC connections failed")


def verify(args):
    manifest = safe_bundle(args.bundle)
    require(manifest["linux"] is not None, "Verified Linux release executable is required")
    require(manifest["linux"].get("platform") == "linux/amd64"
            and linux_binary(args.bundle / "linux" / "relative-publisher") == manifest["linux"]["sha256"], "Linux executable hash mismatch")
    config = read_json(args.config)
    check_configuration(config, read_json(args.intent), int(datetime.datetime.now(datetime.timezone.utc).timestamp()))
    context = args.bundle / "context"
    basic_idl = read_json(context / "packages/cox/idl/cox.json")
    epoch_idl = read_json(context / "packages/cox-epoch/idl/epoch.json")
    basic_deployment = read_json(context / "packages/cox/deploy/devnet.json")
    epoch_deployment = read_json(context / "packages/cox-epoch/deploy/devnet.json")
    require(config.get("basic_program") == basic_idl["address"] == basic_deployment["programId"]
            and config.get("epoch_program") == epoch_idl["address"] == epoch_deployment["programId"],
            "Native program IDs differ from committed IDLs or public deployment configuration")
    require(config.get("operator") == basic_deployment["runtimeAuthority"] == epoch_deployment["runtimeAuthority"]
            and basic_deployment["genesisHash"] == epoch_deployment["genesisHash"] == GENESIS,
            "Native operator or public deployment genesis bindings differ")
    check_genesis()
    print(json.dumps({"schema": "relative.native-preflight/v1", "commit": manifest["commit"],
                      "network": "solana-devnet", "genesisVerified": True, "committedSourcesVerified": True,
                      "contractArtifactByteIntegrityVerified": True, "contractBuildProvenanceVerified": False,
                      "publisherEnabled": False, "activationArmed": False, "transactionsSubmitted": 0,
                      "deploymentAuthorized": False}))


def main():
    parser = argparse.ArgumentParser(description="Stage, build and verify an unarmed committed native publisher release")
    commands = parser.add_subparsers(dest="command", required=True)
    staging = commands.add_parser("stage")
    staging.add_argument("--approved-commit", required=True)
    staging.add_argument("--basic-binary", required=True, type=Path)
    staging.add_argument("--epoch-binary", required=True, type=Path)
    staging.add_argument("--basic-sha256", required=True)
    staging.add_argument("--epoch-sha256", required=True)
    staging.add_argument("--output", required=True, type=Path)
    building = commands.add_parser("build")
    building.add_argument("--bundle", required=True, type=Path)
    building.add_argument("--rust-image", required=True)
    building.add_argument("--runtime-image", required=True)
    checking = commands.add_parser("verify")
    checking.add_argument("--bundle", required=True, type=Path)
    checking.add_argument("--config", required=True, type=Path)
    checking.add_argument("--intent", required=True, type=Path)
    installing = commands.add_parser("install-config")
    installing.add_argument("--source", required=True, type=Path)
    installing.add_argument("--destination", required=True, type=Path)
    args = parser.parse_args()
    for field in ["bundle", "output", "config", "intent", "basic_binary", "epoch_binary", "source", "destination"]:
        if hasattr(args, field):
            setattr(args, field, getattr(args, field).absolute())
    {"stage": stage, "build": build, "verify": verify, "install-config": install_config}[args.command](args)


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        print(f"Release check failed: {error}", file=sys.stderr)
        sys.exit(1)
    except (KeyError, TypeError, AttributeError, OSError, subprocess.SubprocessError):
        print("Release check failed: committed source, artifacts, configuration, build engine or devnet connectivity is not ready", file=sys.stderr)
        sys.exit(1)
