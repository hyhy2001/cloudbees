"""Tests for new DTOs: Controller, Credential, Node, BuildDTO."""

import pytest
from cb.dtos.controller import ControllerDTO
from cb.dtos.credential import CredentialDTO
from cb.dtos.node import NodeDTO, NodeDetailDTO
from cb.dtos.job import BuildDTO, JobDTO


class TestControllerDTO:
    def test_from_dict_basic(self):
        data = {
            "_class": "com.cloudbees.opscenter.server.model.ManagedMaster",
            "name": "my-controller",
            "url": "http://ops/job/my-controller/",
            "description": "Prod controller",
        }
        ctrl = ControllerDTO.from_dict(data)
        assert ctrl.name == "my-controller"
        assert ctrl.online is True

    def test_offline_field(self):
        ctrl = ControllerDTO.from_dict({"name": "down", "offline": True})
        assert ctrl.online is False

    def test_empty_dict(self):
        ctrl = ControllerDTO.from_dict({})
        assert ctrl.name == ""


class TestCredentialDTO:
    def test_from_dict(self):
        data = {
            "id": "my-cred",
            "displayName": "my-cred/***",
            "typeName": "Username with password",
            "scope": "GLOBAL",
            "description": "test",
        }
        cred = CredentialDTO.from_dict(data)
        assert cred.id == "my-cred"
        assert cred.type_name == "Username with password"

    def test_roundtrip(self):
        cred = CredentialDTO(id="x", display_name="x", type_name="U/P", scope="GLOBAL")
        cred2 = CredentialDTO.from_dict(cred.to_dict())
        assert cred2.id == cred.id


class TestNodeDTO:
    def test_from_dict(self):
        data = {
            "displayName": "build-agent-1",
            "offline": False,
            "numExecutors": 4,
            "assignedLabels": [{"name": "build-agent-1"}, {"name": "linux"}],
            "description": "Linux build agent",
        }
        node = NodeDTO.from_dict(data)
        assert node.name == "build-agent-1"
        assert node.offline is False
        assert node.num_executors == 4

    def test_offline_node(self):
        node = NodeDTO.from_dict({"displayName": "down-node", "offline": True})
        assert node.offline is True

    def test_node_detail_launcher_jnlp(self):
        data = {
            "displayName": "jnlp-node",
            "offline": False,
            "numExecutors": 1,
            "launcher": {"_class": "hudson.slaves.JNLPLauncher"},
            "remoteFS": "/home/jenkins",
        }
        detail = NodeDetailDTO.from_dict(data)
        assert detail.launcher_type == "jnlp"
        assert detail.remote_dir == "/home/jenkins"

    def test_node_detail_launcher_ssh(self):
        data = {
            "displayName": "ssh-node",
            "launcher": {"_class": "hudson.plugins.sshslaves.SSHLauncher"},
        }
        detail = NodeDetailDTO.from_dict(data)
        assert detail.launcher_type == "ssh"


class TestBuildDTO:
    def test_from_dict_success(self):
        data = {
            "number": 42,
            "result": "SUCCESS",
            "building": False,
            "duration": 5000,
            "timestamp": 1700000000000,
            "url": "http://jenkins/job/test/42/",
        }
        build = BuildDTO.from_dict(data)
        assert build.number == 42
        assert build.result == "SUCCESS"
        assert build.building is False

    def test_in_progress(self):
        build = BuildDTO.from_dict({"number": 1, "building": True, "result": None})
        assert build.building is True
        assert build.result == ""


class TestJobDTOExtended:
    def test_freestyle_type(self):
        job = JobDTO.from_dict({
            "name": "build",
            "_class": "hudson.model.FreeStyleProject",
        })
        assert job.job_type == "FS"

    def test_pipeline_type(self):
        job = JobDTO.from_dict({
            "name": "pipe",
            "_class": "org.jenkinsci.plugins.workflow.job.WorkflowJob",
        })
        assert job.job_type == "PL"

    def test_folder_type(self):
        job = JobDTO.from_dict({
            "name": "myfolder",
            "_class": "com.cloudbees.hudson.plugins.folder.Folder",
        })
        assert job.job_type == "FD"
