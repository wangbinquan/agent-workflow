"""RFC-371: observe one owned full-scale process; never change its population."""

import argparse
import datetime
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import stat
import subprocess
import sys
import time


def process_tree(pid):
    pending, seen = [pid], set()
    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)
        try:
            pending.extend(int(n) for n in Path(f"/proc/{current}/task/{current}/children").read_text().split())
        except (OSError, ValueError):
            pass
    return seen


def signal_measured_children(wrapper, number):
    """Leave GNU time alive to reap its actual measured Bun and write RUSAGE."""
    signalled = 0
    for child in process_tree(wrapper) - {wrapper}:
        descriptor = None
        try:
            descriptor = os.pidfd_open(child)
            if os.getpgid(child) == wrapper:
                signal.pidfd_send_signal(descriptor, number)
                signalled += 1
        except ProcessLookupError:
            pass
        finally:
            if descriptor is not None:
                os.close(descriptor)
    return signalled


def finish_interrupted_measurement(child):
    signal_measured_children(child.pid, signal.SIGTERM)
    try:
        return child.wait(timeout=30)
    except subprocess.TimeoutExpired:
        signal_measured_children(child.pid, signal.SIGKILL)
        return child.wait(timeout=30)


def verify_interrupted_measurements(directory, source):
    """A measurement-only control, never a reduced full-scale corpus or its PASS."""
    directory.parent.mkdir(parents=True, exist_ok=True)
    directory.mkdir()
    result = {"kind": "measurement-interruption-control", "sourceSha": source,
              "fullScaleQualification": False, "cases": [], "verdict": "FAIL"}
    try:
        for number in (signal.SIGTERM, signal.SIGKILL):
            output = directory / ("process-time-" + str(number) + ".txt")
            fixture = "const memory=new Uint8Array(16*1024*1024);memory.fill(1);console.log(JSON.stringify({pid:process.pid}));setInterval(()=>{if(memory[0]!==1)process.exit(2)},1000)"
            child = subprocess.Popen(["/usr/bin/time", "-v", "-o", str(output), "bun", "-e", fixture],
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     start_new_session=True, text=True)
            try:
                assert select.select([child.stdout], [], [], 10)[0], "Measured Bun did not start"
                measured = json.loads(child.stdout.readline())["pid"]
                assert measured in process_tree(child.pid) and measured != child.pid
                assert signal_measured_children(child.pid, number) >= 1
                code = child.wait(timeout=30)
                raw = output.read_text()
                peak = re.search(r"Maximum resident set size \(kbytes\):\s*(\d+)", raw)
                assert code != 0 and peak is not None and int(peak[1]) > 0
                result["cases"].append({"signal": int(number), "measuredBunPid": measured,
                                        "wrapperExitCode": code, "osPeakRssKbytes": int(peak[1]),
                                        "gnuTimeReceipt": output.name})
            finally:
                if child.poll() is None:
                    finish_interrupted_measurement(child)
                child.stdout.close()
        result["verdict"] = "PASS"
    except BaseException as error:
        result["error"] = str(error)
        raise
    finally:
        with (directory / "control.json").open("x") as receipt:
            json.dump(result, receipt, indent=2)
            receipt.write("\n")
        print(json.dumps(result), flush=True)
    return 0


def disk_sample(directory, pid, elapsed):
    """Deduplicate live paths and owned process fds, including unlinked SQLite TEMP."""
    files, visible, deleted = {}, 0, 0
    categories = {"originalDatabaseBytes": 0, "originalWalBytes": 0, "reportSpoolBytes": 0,
                  "temporaryBytes": 0, "evidenceAndOtherBytes": 0}

    def classify(path, allocated):
        relative = Path(path.removesuffix(" (deleted)")).relative_to(directory).as_posix()
        if relative == "case/original.db":
            category = "originalDatabaseBytes"
        elif relative.startswith("case/original.db-"):
            category = "originalWalBytes"
        elif relative.startswith("case/operations/observation-reports/"):
            category = "reportSpoolBytes"
        elif relative.startswith("temporary/"):
            category = "temporaryBytes"
        else:
            category = "evidenceAndOtherBytes"
        categories[category] += allocated
    for root, _, names in os.walk(directory):
        for name in names:
            try:
                info = os.stat(Path(root) / name, follow_symlinks=False)
                if stat.S_ISREG(info.st_mode):
                    key = (info.st_dev, info.st_ino)
                    if key not in files:
                        files[key] = info.st_blocks * 512
                        visible += files[key]
                        classify(str(Path(root) / name), files[key])
            except OSError:
                pass
    for child in process_tree(pid):
        try:
            descriptors = list(Path(f"/proc/{child}/fd").iterdir())
        except OSError:
            continue
        for descriptor in descriptors:
            try:
                target = os.readlink(descriptor)
                # Only this run's working directory; do not inventory unrelated processes/files.
                if not target.startswith(str(directory) + os.sep):
                    continue
                info = descriptor.stat()
                key = (info.st_dev, info.st_ino)
                if stat.S_ISREG(info.st_mode) and key not in files:
                    files[key] = info.st_blocks * 512
                    deleted += files[key]
                    classify(target, files[key])
            except OSError:
                pass
    return {"elapsedSeconds": elapsed, **categories, "visibleAllocatedBytes": visible,
            "openUnlinkedAllocatedBytes": deleted, "ownedAllocatedBytes": sum(files.values()),
            "rootFreeBytes": shutil.disk_usage(directory).free}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--verify-interruptions", action="store_true")
    args = parser.parse_args()

    def interrupted(number, _):
        raise InterruptedError("Owned scale observer received signal " + str(number))

    signal.signal(signal.SIGTERM, interrupted)
    root = Path(__file__).resolve().parent.parent
    mode, source = os.environ.get("AW_OBSERVABILITY_SCALE_MODE"), os.environ.get("AW_OBSERVABILITY_SCALE_SHA", "")
    assert mode in ("full-report", "self-total"), "Only an exact full scenario is accepted"
    assert re.fullmatch("[a-f0-9]{40}", source), "An exact source SHA is required"
    assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip() == source
    assert sys.platform == "linux" and Path("/proc/self/fd").is_dir(), "Hosted Linux process measurements are required"
    assert hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"), "Original Linux child handles are required"
    assert Path("/usr/bin/time").is_file(), "GNU time is required on the hosted Linux runner"
    directory = Path(args.output).resolve()
    if args.verify_interruptions:
        return verify_interrupted_measurements(directory, source)
    directory.parent.mkdir(parents=True, exist_ok=True)
    directory.mkdir()  # No reuse, clearing or overwriting a prior success/failure.
    temporary = directory / "temporary"
    temporary.mkdir()
    env = {**os.environ, "TMPDIR": str(temporary), "SQLITE_TMPDIR": str(temporary),
           "AW_OBSERVABILITY_SCALE_OUTPUT": str(directory / "case")}
    started, child = time.monotonic(), None
    result = {"sourceSha": source, "scenario": mode, "syntheticValidationOnly": True,
              "supplierInvoice": False, "taskCount": 100000 if mode == "full-report" else 0,
              "records": 10000000, "sampleIntervalSeconds": 5,
              "diskPeakKind": "sampled maximum, including owned open unlinked files",
              "osPeakRssSource": "process-time.txt: GNU time -v, maximum resident set in kbytes",
              "bunVersion": subprocess.check_output(["bun", "--version"], text=True).strip(),
              "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    maximum, minimum_free, samples = 0, None, 0
    try:
        with (directory / "qualification.log").open("x", buffering=1) as log, (directory / "disk-samples.jsonl").open("x", buffering=1) as measurements:
            child = subprocess.Popen(["/usr/bin/time", "-v", "-o", str(directory / "process-time.txt"),
                                      "bun", "tests/helpers/rfc371ScaleQualification.ts"],
                                     cwd=root / "packages/backend", env=env, stdout=log,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            while True:
                sample = disk_sample(directory, child.pid, time.monotonic() - started)
                measurements.write(json.dumps(sample) + "\n")
                maximum = max(maximum, sample["ownedAllocatedBytes"])
                minimum_free = sample["rootFreeBytes"] if minimum_free is None else min(minimum_free, sample["rootFreeBytes"])
                samples += 1
                try:
                    code = child.wait(timeout=5)
                    final = disk_sample(directory, child.pid, time.monotonic() - started)
                    measurements.write(json.dumps(final) + "\n")
                    maximum = max(maximum, final["ownedAllocatedBytes"])
                    minimum_free = min(minimum_free, final["rootFreeBytes"])
                    samples += 1
                    result["processExitCode"] = code
                    break
                except subprocess.TimeoutExpired:
                    continue
        qualification = json.loads((directory / "case/qualification.json").read_text())
        assert qualification["sourceSha"] == source and qualification["mode"] == mode
        assert qualification["records"] == 10000000 and qualification["taskCount"] == result["taskCount"]
        result["verdict"] = "PASS" if code == 0 and qualification["verdict"] == "PASS" else "FAIL"
    except BaseException as error:
        result["verdict"], result["error"] = "FAIL", str(error)
        if child is not None and child.poll() is None:
            result["processExitCode"] = finish_interrupted_measurement(child)
        raise
    finally:
        result.update({"elapsedSeconds": time.monotonic() - started, "diskSamples": samples,
                       "sampledMaximumOwnedAllocatedBytes": maximum, "minimumObservedRootFreeBytes": minimum_free,
                       "finishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()})
        with (directory / "observer.json").open("x") as receipt:
            json.dump(result, receipt, indent=2)
            receipt.write("\n")
        print(json.dumps(result), flush=True)
    return 0 if result["verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
