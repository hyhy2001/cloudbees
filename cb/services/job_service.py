from __future__ import annotations
"""Job service -- list, get, create (Freestyle/Pipeline/Folder), run, stop, log."""

import time
from pathlib import Path
from typing import Optional, List

from cb.api.client import CloudBeesClient
from cb.api.xml_builder import build_freestyle_xml, build_pipeline_xml, build_folder_xml, inject_email_publisher
from cb.dtos.job import JobDTO, BuildDTO


_JOB_TREE = "jobs[_class,name,url,color,description,buildable,lastBuild[number,result,url]]"
_JOB_DETAIL_TREE = "_class,name,url,color,description,buildable,lastBuild[number,result,url]"

def list_jobs(
    client: CloudBeesClient,
) -> List[JobDTO]:
    """
    List jobs. Uses the client's base_url directly.
    """
    endpoint = f"/api/json?tree={_JOB_TREE}"
    cache_key = f"jobs.list.{client.base_url}"
    data = client.get(endpoint, cache_key=cache_key)
    return [JobDTO.from_dict(j) for j in (data or {}).get("jobs", [])]

def get_job(client: CloudBeesClient, name: str) -> Optional[JobDTO]:
    """Get job details by finding it in the list of all jobs."""
    try:
        # First try the direct approach with a simplified query
        try:
            data = client.get(
                f"/job/{name}/api/json?tree=name,url",
                cache_key=f"jobs.exists.{name}",
            )
            # If we get here, the job exists, but we might not have all details
        except Exception as e:
            if "404" in str(e):
                return None
            # For other errors, we'll try the list approach below
        
        # Get all jobs and find the one we're looking for
        all_jobs = list_jobs(client)
        for job in all_jobs:
            if job.name == name:
                return job
        
        # If we didn't find the job in the list but it exists (from the first check),
        # return a minimal JobDTO
        if data:
            return JobDTO(
                name=data.get("name", ""),
                url=data.get("url", ""),
                color="unknown",
                description="",
                job_type="",
                buildable=True,
                last_build_number=None,
                last_build_url=None,
                job_class=""
            )
        
        return None
    except Exception as e:
        if "404" in str(e):
            return None
        raise e


def trigger_job(client: CloudBeesClient, name: str) -> None:
    """Trigger a job build using the client's configured context."""
    client.post(f"/job/{name}/build", invalidate="jobs.")


def trigger_job_with_params(client: CloudBeesClient, name: str, params: dict) -> None:
    client.post(
        f"/job/{name}/buildWithParameters",
        invalidate="jobs.",
        params=params,
    )


def stop_build(client: CloudBeesClient, job_name: str, build_number: int) -> None:
    client.post(f"/job/{job_name}/{build_number}/stop", invalidate="jobs.")


def get_build_detail(client: CloudBeesClient, job_name: str, build_number: int) -> BuildDTO:
    data = client.get(f"/job/{job_name}/{build_number}/api/json")
    return BuildDTO.from_dict(data or {})


def get_last_build_number(client: CloudBeesClient, job_name: str) -> Optional[int]:
    """Get the last build number for a job, using a simplified API query."""
    try:
        # Use a simpler query with fewer fields to avoid HTTP 400 errors
        data = client.get(
            f"/job/{job_name}/api/json?tree=lastBuild[number]",
            cache_key=f"jobs.lastbuild.{job_name}",
        )
        if data and data.get("lastBuild") and data["lastBuild"].get("number") is not None:
            return data["lastBuild"]["number"]
        return None
    except Exception as e:
        # If we get a 404, the job doesn't exist
        if "404" in str(e):
            raise e
        # For HTTP 400, try an even simpler approach
        if "400" in str(e):
            try:
                # Just check if the job exists
                data = client.get(
                    f"/job/{job_name}/api/json?tree=name",
                    cache_key=f"jobs.exists.{job_name}",
                )
                # If we get here, the job exists but we can't get the last build
                # Let's try to check the builds directory
                builds_data = client.get(
                    f"/job/{job_name}/api/json?tree=builds[number]",
                    cache_key=f"jobs.builds.{job_name}",
                )
                if builds_data and builds_data.get("builds"):
                    builds = builds_data["builds"]
                    if builds and len(builds) > 0 and "number" in builds[0]:
                        return builds[0]["number"]
                return None
            except Exception:
                # If all else fails, re-raise the original error
                raise e
        raise e


def get_build_log(client: CloudBeesClient, job_name: str, build_number: int) -> str:
    """Return console text for a specific build."""
    return client.get_text(f"/job/{job_name}/{build_number}/consoleText")


def get_last_build_log(client: CloudBeesClient, job_name: str) -> str:
    """Return console text for the most recent build."""
    build_num = get_last_build_number(client, job_name)
    if build_num is None:
        return "(No builds found)"
    return get_build_log(client, job_name, build_num)

def stream_build_log(client: CloudBeesClient, job_name: str, build_num: int, start: int = 0) -> tuple[str, int, bool]:
    """Progressively stream the build console log."""
    return client.get_progressive_text(f"/job/{job_name}/{build_num}/logText/progressiveText", start=start)

def stream_last_build_log(client: CloudBeesClient, job_name: str, start: int = 0) -> tuple[str, int, bool]:
    build_num = get_last_build_number(client, job_name)
    if build_num is None:
        return "", start, False
    return stream_build_log(client, job_name, build_num, start)

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


# -- Create jobs -----------------------------------------------


def create_freestyle_job(
    client: CloudBeesClient,
    name: str,
    desc: str = "",
    shell_cmd: str = "echo hello",
    chdir=None,
    node: Optional[str] = None,
    schedule: Optional[str] = None,
    email: Optional[str] = None,
    email_cond: str = "failed",
) -> None:
    xml = build_freestyle_xml(desc=desc, shell_cmd=shell_cmd, chdir=chdir, node=node, schedule=schedule, email=email, email_cond=email_cond)
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
    node: Optional[str] = None,
    schedule: Optional[str] = None,
    email: Optional[str] = None,
    email_cond: str = "failed",
) -> None:
    if not script:
        script = "pipeline {\n  agent any\n  stages {\n    stage('Build') {\n      steps { echo 'Hello' }\n    }\n  }\n"
        if email:
            if email_cond == "always":
                script += f"  post {{\n    always {{\n      mail to: '{email}', subject: 'Build Result', body: 'Build finished'\n    }}\n  }}\n"
            elif email_cond == "success":
                script += f"  post {{\n    success {{\n      mail to: '{email}', subject: 'Build Success', body: 'Build succeeded'\n    }}\n  }}\n"
            else:
                script += f"  post {{\n    failure {{\n      mail to: '{email}', subject: 'Build Failed', body: 'Build failed'\n    }}\n  }}\n"
        script += "}"
    xml = build_pipeline_xml(desc=desc, script=script, node=node, schedule=schedule)
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
    try:
        client.post(f"/job/{name}/doDelete")
    except Exception as e:
        # If the server returns a 404, it means the job is already deleted.
        # We can safely ignore this error.
        if "404" in str(e):
            return
        raise e


import xml.etree.ElementTree as ET

def _get_job_config(client: CloudBeesClient, name: str) -> ET.Element:
    xml_str = client.get_text(f"/job/{name}/config.xml")
    return ET.fromstring(xml_str)

def _post_job_config(client: CloudBeesClient, name: str, root: ET.Element) -> None:
    # Need to include the XML declaration
    xml_str = "<?xml version='1.1' encoding='UTF-8'?>\n" + ET.tostring(root, encoding="unicode")
    client.post_xml(
        f"/job/{name}/config.xml",
        xml_str=xml_str,
        invalidate="jobs.",
    )

def update_job_freestyle(
    client: CloudBeesClient,
    name: str,
    desc: Optional[str] = None,
    shell_cmd: Optional[str] = None,
    node: Optional[str] = None,
    schedule: Optional[str] = None,
    email: Optional[str] = None,
    email_cond: Optional[str] = None,
) -> None:
    root = _get_job_config(client, name)
    
    if desc is not None:
        desc_elem = root.find("description")
        if desc_elem is None:
            desc_elem = ET.SubElement(root, "description")
        desc_elem.text = desc

    if node is not None:
        node_elem = root.find("assignedNode")
        if node_elem is None:
            node_elem = ET.SubElement(root, "assignedNode")
        node_elem.text = node
        
        roam_elem = root.find("canRoam")
        if roam_elem is None:
            roam_elem = ET.SubElement(root, "canRoam")
        roam_elem.text = "false" if node else "true"

    if shell_cmd is not None:
        builders = root.find("builders")
        if builders is None:
            builders = ET.SubElement(root, "builders")
        shell_elem = builders.find("hudson.tasks.Shell")
        if shell_elem is None:
            shell_elem = ET.SubElement(builders, "hudson.tasks.Shell")
        cmd_elem = shell_elem.find("command")
        if cmd_elem is None:
            cmd_elem = ET.SubElement(shell_elem, "command")
        cmd_elem.text = shell_cmd

    if schedule is not None:
        triggers = root.find("triggers")
        if triggers is None:
            triggers = ET.SubElement(root, "triggers")
        for t in triggers.findall("hudson.triggers.TimerTrigger"):
            triggers.remove(t)
        if schedule:
            timer = ET.SubElement(triggers, "hudson.triggers.TimerTrigger")
            spec = ET.SubElement(timer, "spec")
            spec.text = schedule

    if email is not None:
        publishers = root.find("publishers")
        if publishers is None:
            publishers = ET.SubElement(root, "publishers")
        for p in publishers.findall("hudson.plugins.emailext.ExtendedEmailPublisher"):
            publishers.remove(p)
        if email:
            inject_email_publisher(publishers, email, email_cond or "failed")

    _post_job_config(client, name, root)


def update_job_pipeline(
    client: CloudBeesClient,
    name: str,
    desc: Optional[str] = None,
    script: Optional[str] = None,
    schedule: Optional[str] = None,
) -> None:
    root = _get_job_config(client, name)
    
    if desc is not None:
        desc_elem = root.find("description")
        if desc_elem is None:
            desc_elem = ET.SubElement(root, "description")
        desc_elem.text = desc

    if script is not None:
        definition = root.find("definition")
        if definition is None:
            definition = ET.SubElement(root, "definition", {"class": "org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition", "plugin": "workflow-cps"})
        script_elem = definition.find("script")
        if script_elem is None:
            script_elem = ET.SubElement(definition, "script")
        script_elem.text = script
        sandbox = definition.find("sandbox")
        if sandbox is None:
            sandbox = ET.SubElement(definition, "sandbox")
            sandbox.text = "true"

    if schedule is not None:
        triggers = root.find("triggers")
        if triggers is None:
            triggers = ET.SubElement(root, "triggers")
        for t in triggers.findall("hudson.triggers.TimerTrigger"):
            triggers.remove(t)
        if schedule:
            timer = ET.SubElement(triggers, "hudson.triggers.TimerTrigger")
            spec = ET.SubElement(timer, "spec")
            spec.text = schedule

    _post_job_config(client, name, root)
