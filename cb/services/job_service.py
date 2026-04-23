from __future__ import annotations
"""Job service -- list, get, create (Freestyle/Folder), run, stop, log."""

import re
import time
from typing import Optional
import xml.etree.ElementTree as ET

from cb.api.client import CloudBeesClient
from cb.api.xml_builder import (
    build_folder_xml,
    build_freestyle_xml,
    inject_email_publisher,
    parse_email_filter_metadata,
)
from cb.dtos.job import BuildDTO, JobDTO


_JOB_TREE = "jobs[_class,name,url,color,description,buildable,lastBuild[number,result,url]]"
_JOB_DETAIL_TREE = "_class,name,url,color,description,buildable,lastBuild[number,result,url]"


def list_jobs(
    client: CloudBeesClient,
) -> list[JobDTO]:
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
        data = None
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
                job_class="",
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


def get_build_history(client: CloudBeesClient, job_name: str, count: int = 10) -> list[BuildDTO]:
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


def _normalize_keywords(email_keywords: list[str] | tuple[str, ...] | None) -> list[str]:
    if email_keywords is None:
        return []
    out: list[str] = []
    for item in email_keywords:
        if item is None:
            continue
        val = str(item).strip()
        if val:
            out.append(val)
    return out


def _normalize_regex(email_regex: Optional[str]) -> Optional[str]:
    if email_regex is None:
        return None
    val = str(email_regex).strip()
    return val or None


def _validate_regex(email_regex: Optional[str]) -> None:
    if not email_regex:
        return
    try:
        re.compile(email_regex)
    except re.error as exc:
        raise ValueError(f"Invalid --email-regex: {exc}") from exc


def _extract_email_publisher(publishers: ET.Element | None) -> ET.Element | None:
    if publishers is None:
        return None
    return publishers.find("hudson.plugins.emailext.ExtendedEmailPublisher")


def _remove_email_publishers(publishers: ET.Element | None) -> None:
    if publishers is None:
        return
    for elem in list(publishers.findall("hudson.plugins.emailext.ExtendedEmailPublisher")):
        publishers.remove(elem)


def _infer_email_cond_from_publisher(ext_mail: ET.Element | None) -> str:
    if ext_mail is None:
        return "failed"
    triggers = ext_mail.find("configuredTriggers")
    if triggers is None:
        return "failed"

    has_failure = bool(triggers.find("hudson.plugins.emailext.plugins.trigger.FailureTrigger"))
    has_success = bool(triggers.find("hudson.plugins.emailext.plugins.trigger.SuccessTrigger"))

    if has_failure and has_success:
        return "always"
    if has_success:
        return "success"
    return "failed"


def _existing_email_value(ext_mail: ET.Element | None) -> Optional[str]:
    if ext_mail is None:
        return None
    elem = ext_mail.find("recipientList")
    if elem is None or elem.text is None:
        return None
    val = elem.text.strip()
    return val or None


def _existing_filter_from_publisher(ext_mail: ET.Element | None) -> tuple[list[str], Optional[str]]:
    if ext_mail is None:
        return [], None
    presend = ext_mail.find("presendScript")
    metadata = parse_email_filter_metadata(presend.text if presend is not None else None)
    if not metadata:
        return [], None
    return _normalize_keywords(metadata.get("keywords")), _normalize_regex(metadata.get("regex"))


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
    email_keywords: list[str] | tuple[str, ...] | None = None,
    email_regex: Optional[str] = None,
) -> None:
    keywords = _normalize_keywords(email_keywords)
    regex = _normalize_regex(email_regex)
    _validate_regex(regex)
    if (keywords or regex) and not (email and email.strip()):
        raise ValueError("Email filters require recipient email. Provide --email.")

    xml = build_freestyle_xml(
        desc=desc,
        shell_cmd=shell_cmd,
        chdir=chdir,
        node=node,
        schedule=schedule,
        email=email,
        email_cond=email_cond,
        email_keywords=keywords,
        email_regex=regex,
    )
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


def copy_job(client: CloudBeesClient, src_name: str, dest_name: str) -> None:
    """Clones an existing job by mirroring its config.xml."""
    xml_str = client.get_text(f"/job/{src_name}/config.xml")
    client.post_xml(
        f"/createItem?name={dest_name}",
        xml_str=xml_str,
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


def get_job_config_summary(client: CloudBeesClient, name: str) -> dict:
    """Read the config.xml and extract schedule and email information."""
    summary = {"schedule": "-", "email": "-"}
    try:
        root = _get_job_config(client, name)
        # 1. Triggers / Schedule
        triggers = root.find("triggers")
        if triggers is not None:
            timer = triggers.find("hudson.triggers.TimerTrigger")
            if timer is not None:
                spec = timer.find("spec")
                if spec is not None and spec.text:
                    summary["schedule"] = spec.text.strip()

        # 2. Publishers / Email (Freestyle usually)
        publishers = root.find("publishers")
        if publishers is not None:
            ext_mail = publishers.find("hudson.plugins.emailext.ExtendedEmailPublisher")
            if ext_mail is not None:
                rl = ext_mail.find("recipientList")
                if rl is not None and rl.text:
                    summary["email"] = rl.text.strip()
            else:
                mailer = publishers.find("hudson.tasks.Mailer")
                if mailer is not None:
                    rec = mailer.find("recipients")
                    if rec is not None and rec.text:
                        summary["email"] = rec.text.strip() + " (Built-in Mailer)"
    except Exception:
        pass
    return summary


def update_job_freestyle(
    client: CloudBeesClient,
    name: str,
    desc: Optional[str] = None,
    shell_cmd: Optional[str] = None,
    node: Optional[str] = None,
    schedule: Optional[str] = None,
    email: Optional[str] = None,
    email_cond: Optional[str] = None,
    email_keywords: list[str] | tuple[str, ...] | None = None,
    email_regex: Optional[str] = None,
    clear_email_keywords: bool = False,
    clear_email_regex: bool = False,
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

    should_update_email = any(
        [
            email is not None,
            email_cond is not None,
            email_keywords is not None,
            email_regex is not None,
            clear_email_keywords,
            clear_email_regex,
        ]
    )

    if should_update_email:
        publishers = root.find("publishers")
        if publishers is None:
            publishers = ET.SubElement(root, "publishers")

        current_ext = _extract_email_publisher(publishers)
        current_email = _existing_email_value(current_ext)
        current_cond = _infer_email_cond_from_publisher(current_ext)
        current_keywords, current_regex = _existing_filter_from_publisher(current_ext)

        requested_keywords = _normalize_keywords(email_keywords) if email_keywords is not None else None
        requested_regex = _normalize_regex(email_regex) if email_regex is not None else None
        _validate_regex(requested_regex)

        has_new_filter_values = bool(requested_keywords) or bool(requested_regex)

        if email is not None:
            target_email = email.strip()
        else:
            target_email = current_email or ""

        if email is not None and target_email == "":
            if has_new_filter_values:
                raise ValueError("Cannot set email filters when removing recipient email.")
            _remove_email_publishers(publishers)
        else:
            if not target_email:
                if has_new_filter_values:
                    raise ValueError("Email filters require recipient email. Provide --email.")
                if email_cond is not None:
                    raise ValueError("Email condition requires recipient email. Provide --email.")
            else:
                target_cond = email_cond or current_cond

                target_keywords = list(current_keywords)
                target_regex = current_regex

                if clear_email_keywords:
                    target_keywords = []
                if clear_email_regex:
                    target_regex = None

                if requested_keywords is not None:
                    target_keywords = requested_keywords
                if email_regex is not None:
                    target_regex = requested_regex

                _validate_regex(target_regex)

                if (target_keywords or target_regex) and not target_email:
                    raise ValueError("Email filters require recipient email. Provide --email.")

                _remove_email_publishers(publishers)
                inject_email_publisher(
                    publishers,
                    target_email,
                    target_cond,
                    email_keywords=target_keywords,
                    email_regex=target_regex,
                )

    _post_job_config(client, name, root)
