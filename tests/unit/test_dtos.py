"""Tests for DTOs."""

import pytest
from cb.dtos.job import JobDTO, JobRunDTO
from cb.dtos.pipeline import PipelineDTO
from cb.dtos.user import UserDTO


def test_job_dto_from_dict():
    data = {
        "name": "build-main",
        "url": "http://cb.example.com/job/build-main/",
        "color": "blue",
        "buildable": True,
        "description": "Main build",
        "lastBuild": {"number": 42, "url": "http://cb.example.com/job/build-main/42/"},
    }
    job = JobDTO.from_dict(data)
    assert job.name == "build-main"
    assert job.color == "blue"
    assert job.last_build_number == 42


def test_job_dto_roundtrip():
    job = JobDTO(id="x", name="x", url="http://x", color="blue")
    d = job.to_dict()
    job2 = JobDTO.from_dict(d)
    assert job2.name == job.name


def test_job_dto_missing_fields():
    """from_dict should not raise on partial data."""
    job = JobDTO.from_dict({"name": "minimal"})
    assert job.name == "minimal"
    assert job.last_build_number is None


def test_pipeline_dto_from_dict():
    data = {"name": "my-pipe", "url": "http://x", "color": "red"}
    pipe = PipelineDTO.from_dict(data)
    assert pipe.name == "my-pipe"
    assert pipe.status == "RED"


def test_user_dto_from_dict():
    data = {"id": "alice", "fullName": "Alice Smith", "absoluteUrl": "http://x/user/alice"}
    u = UserDTO.from_dict(data)
    assert u.id == "alice"
    assert u.full_name == "Alice Smith"
