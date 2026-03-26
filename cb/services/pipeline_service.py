"""Pipeline service."""

from __future__ import annotations
from cb.api.client import CloudBeesClient
from cb.dtos.pipeline import PipelineDTO, PipelineRunDTO


def list_pipelines(client: CloudBeesClient) -> list[PipelineDTO]:
    data = client.get(
        "/api/json?tree=jobs[name,url,color,description]",
        cache_key="pipelines.list",
    )
    return [PipelineDTO.from_dict(j) for j in (data or {}).get("jobs", [])]


def get_pipeline(client: CloudBeesClient, name: str) -> PipelineDTO:
    data = client.get(f"/job/{name}/api/json", cache_key=f"pipelines.detail.{name}")
    return PipelineDTO.from_dict(data or {})


def run_pipeline(client: CloudBeesClient, name: str) -> str:
    client.post(f"/job/{name}/build", invalidate="pipelines.")
    return f"Pipeline '{name}' triggered."


def get_run_status(client: CloudBeesClient, name: str, run_id: str) -> PipelineRunDTO:
    data = client.get(
        f"/job/{name}/wfapi/runs/{run_id}",
        cache_key=f"pipelines.detail.{name}.{run_id}",
    )
    return PipelineRunDTO.from_dict(data or {})
