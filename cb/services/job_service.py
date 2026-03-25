from __future__ import annotations
"""Job service — list, get, create (Freestyle/Pipeline/Folder), run, stop, log."""

import time
from pathlib import Path
from typing import Optional, List

from cb.api.client import CloudBeesClient
from cb.api.xml_builder import build_freestyle_xml, build_pipeline_xml, build_folder_xml
from cb.dtos.job import JobDTO, BuildDTO


_JOB_TREE = "jobs[_class,name,url,color,description,buildable,lastBuild[number,result,url]]"


def list_jobs(
    client: CloudBeesClient,
    db_path=None,
    controller_name: str | None = None,
) -> List[JobDTO]:
    """
    List jobs scoped to active controller on CloudBees OC.

    No controller -> /cjoc/api/json   (OC default context)
    Controller    -> /job/<ctrl>/api/json
    """
    from cb.services.controller_service import get_active_controller

    ctrl = controller_name
    if ctrl is None:
        active = get_active_controller(db_path)
        ctrl   = active[0] if active else None

    if ctrl:
        endpoint  = f"/job/{ctrl}/api/json?tree={_JOB_TREE}"
        cache_key = f"jobs.list.{ctrl}"
    else:
        endpoint  = f"/cjoc/api/json?tree={_JOB_TREE}"
        cache_key = "jobs.list.cjoc"

    data = client.get(endpoint, cache_key=cache_key)
    return [JobDTO.from_dict(j) for j in (data or {}).get("jobs", [])]


def get_job(client: CloudBeesClient, name: str) -> JobDTO:
    data = client.get(
        f"/job/{name}/api/json",
        cache_key=f"jobs.detail.{name}",
    )
    return JobDTO.from_dict(data or {})


def trigger_job(
    client: CloudBeesClient,
    name: str,
    controller_name: Optional[str] = None,
    db_path=None,
) -> None:
    """Trigger a job build scoped to the active controller."""
    from cb.services.controller_service import get_active_controller
    ctrl = controller_name
    if ctrl is None and db_path is not None:
        active = get_active_controller(db_path)
        ctrl   = active[0] if active else None
    if ctrl:
        client.post(f"/job/{ctrl}/job/{name}/build", invalidate="jobs.")
    else:
        client.post(f"/cjoc/job/{name}/build", invalidate="jobs.")


def trigger_job_with_params(client: CloudBeesClient, name: str, params: dict) -> None:
    client.post(
        f"/job/{name}/buildWithParameters",
        invalidate="jobs.",
        params=params,
    )


def stop_build(client: CloudBeesClient, job_name: str, build_number: int) -> None:
    client.post(f"/job/{job_name}/{build_number}/stop")


def get_build_detail(client: CloudBeesClient, job_name: str, build_number: int) -> BuildDTO:
    data = client.get(f"/job/{job_name}/{build_number}/api/json")
    return BuildDTO.from_dict(data or {})


def get_last_build_number(client: CloudBeesClient, job_name: str) -> Optional[int]:
    job = get_job(client, job_name)
    return job.last_build_number


def get_build_log(client: CloudBeesClient, job_name: str, build_number: int) -> str:
    """Return console text for a specific build."""
    return client.get_text(f"/job/{job_name}/{build_number}/consoleText")


def get_last_build_log(client: CloudBeesClient, job_name: str) -> str:
    """Return console text for the most recent build."""
    build_num = get_last_build_number(client, job_name)
    if build_num is None:
        return "(No builds found)"
    return get_build_log(client, job_name, build_num)


def get_build_history(client: CloudBeesClient, job_name: str, count: int = 10) -> List[BuildDTO]:
    """Return recent build history."""
    data = client.get(
        f"/job/{job_name}/api/json?tree=builds[number,result,building,duration,timestamp,url]{{0,{count}}}"
    )
    builds = (data or {}).get("builds", [])
    return [BuildDTO.from_dict(b) for b in builds]


def wait_for_build(
    client: CloudBeesClient,
    job_name: str,
    build_number: int,
    timeout: int = 120,
    poll_interval: int = 5,
) -> BuildDTO:
    """Poll until build completes or timeout, then return final BuildDTO."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        build = get_build_detail(client, job_name, build_number)
        if not build.building:
            return build
        time.sleep(poll_interval)
    # Return last known state
    return get_build_detail(client, job_name, build_number)


# ── Create jobs ───────────────────────────────────────────────


def create_freestyle_job(
    client: CloudBeesClient,
    name: str,
    desc: str = "",
    shell_cmd: str = "echo hello",
) -> None:
    xml = build_freestyle_xml(desc=desc, shell_cmd=shell_cmd)
    client.post_xml(
        f"/createItem?name={name}",
        xml_str=xml,
        invalidate="jobs.",
    )


def create_pipeline_job(
    client: CloudBeesClient,
    name: str,
    desc: str = "",
    script: str = "",
) -> None:
    if not script:
        script = "pipeline {\n  agent any\n  stages {\n    stage('Build') {\n      steps { echo 'Hello' }\n    }\n  }\n}"
    xml = build_pipeline_xml(desc=desc, script=script)
    client.post_xml(
        f"/createItem?name={name}",
        xml_str=xml,
        invalidate="jobs.",
    )


def create_folder(
    client: CloudBeesClient,
    name: str,
    desc: str = "",
) -> None:
    xml = build_folder_xml(desc=desc)
    client.post_xml(
        f"/createItem?name={name}",
        xml_str=xml,
        invalidate="jobs.",
    )


def delete_job(client: CloudBeesClient, name: str) -> None:
    client.post(f"/job/{name}/doDelete", invalidate="jobs.")
