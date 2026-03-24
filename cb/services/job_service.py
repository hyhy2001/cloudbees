"""Job service — business logic for CloudBees jobs."""

from __future__ import annotations
from cb.api.client import CloudBeesClient
from cb.dtos.job import JobDTO, JobRunDTO


def list_jobs(client: CloudBeesClient, folder: str = "") -> list[JobDTO]:
    base = f"/{folder}" if folder else ""
    data = client.get(
        f"{base}/api/json?tree=jobs[name,url,color,buildable,description,lastBuild[number,url]]",
        cache_key="jobs.list",
    )
    jobs_raw = (data or {}).get("jobs", [])
    return [JobDTO.from_dict(j) for j in jobs_raw]


def get_job(client: CloudBeesClient, job_name: str) -> JobDTO:
    data = client.get(
        f"/job/{job_name}/api/json",
        cache_key=f"jobs.detail.{job_name}",
    )
    return JobDTO.from_dict(data or {})


def trigger_job(client: CloudBeesClient, job_name: str) -> str:
    """Trigger a build. Returns the queue URL."""
    resp = client.post(
        f"/job/{job_name}/build",
        invalidate="jobs.",
    )
    return str(resp) if resp else "Build triggered."


def stop_job(client: CloudBeesClient, job_name: str, build_number: int) -> None:
    client.post(
        f"/job/{job_name}/{build_number}/stop",
        invalidate=f"jobs.detail.{job_name}",
    )


def get_build(client: CloudBeesClient, job_name: str, build_number: int) -> JobRunDTO:
    data = client.get(
        f"/job/{job_name}/{build_number}/api/json",
        cache_key=f"jobs.detail.{job_name}.{build_number}",
    )
    return JobRunDTO.from_dict(data or {})
