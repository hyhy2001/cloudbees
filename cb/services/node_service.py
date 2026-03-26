from __future__ import annotations
"""Node / Agent service — list, get, create, copy, delete, toggle offline."""

import json
from pathlib import Path
from typing import Optional, List

from cb.api.client import CloudBeesClient
from cb.dtos.node import NodeDTO, NodeDetailDTO

_NODE_TREE = "computer[displayName,offline,numExecutors,assignedLabels[name],description]"


def list_nodes(client: CloudBeesClient) -> List[NodeDTO]:
    cache_key = f"nodes.list.{client.base_url}"
    data = client.get(
        f"/computer/api/json?tree={_NODE_TREE}",
        cache_key=cache_key,
    )
    computers = (data or {}).get("computer", [])
    return [NodeDTO.from_dict(c) for c in computers]


def get_node(client: CloudBeesClient, name: str) -> NodeDetailDTO:
    data = client.get(
        f"/computer/{name}/api/json",
        cache_key=f"nodes.detail.{name}",
    )
    dto = NodeDetailDTO.from_dict(data or {})
    try:
        xml = client.get_text(f"/computer/{name}/config.xml")
        dto.config_xml = xml
    except Exception:
        pass
    return dto


def create_permanent_node(
    client: CloudBeesClient,
    name: str,
    remote_dir: str,
    num_executors: int = 1,
    labels: str = "",
    desc: str = "",
    host: str = "",
    port: int = 22,
    credentials_id: str = "",
    java_path: str = "/usr/local/java/openjdk-19.0.2-7/bin/java",
) -> None:
    """Create a Permanent Agent with Form Data matching python-jenkins exactly."""
    
    if host:
        launcher = {
            "stapler-class": "hudson.plugins.sshslaves.SSHLauncher",
            "$class": "hudson.plugins.sshslaves.SSHLauncher",
            "host": host,
            "port": port,
            "credentialsId": credentials_id,
            "javaPath": java_path,
            "sshHostKeyVerificationStrategy": {
                "stapler-class": "hudson.plugins.sshslaves.verifiers.NonVerifyingKeyVerificationStrategy",
                "$class": "hudson.plugins.sshslaves.verifiers.NonVerifyingKeyVerificationStrategy"
            }
        }
    else:
        launcher = {
            "stapler-class": "hudson.slaves.JNLPLauncher",
            "$class": "hudson.slaves.JNLPLauncher"
        }

    json_payload = {
        "name": name,
        "nodeDescription": desc,
        "numExecutors": str(num_executors),
        "remoteFS": remote_dir,
        "labelString": labels,
        "mode": "NORMAL",
        "type": "hudson.slaves.DumbSlave",
        "retentionStrategy": {
            "stapler-class": "hudson.slaves.RetentionStrategy$Always",
            "$class": "hudson.slaves.RetentionStrategy$Always"
        },
        "nodeProperties": {"stapler-class-bag": "true"},
        "launcher": launcher
    }

    data = {
        "name": name,
        "type": "hudson.slaves.DumbSlave",
        "json": json.dumps(json_payload)
    }

    client.post(
        "/computer/doCreateItem",
        data=data,
        invalidate="nodes.",
    )


def copy_node(
    client: CloudBeesClient, 
    source_name: str, 
    new_name: str,
) -> None:
    """Copy an existing node's config and register it with a new name using Form Data."""
    data = {
        "name": new_name,
        "mode": "copy",
        "from": source_name,
    }
    client.post(
        "/computer/doCreateItem",
        data=data,
        invalidate="nodes.",
    )


def delete_node(client: CloudBeesClient, name: str) -> None:
    client.post(f"/computer/{name}/doDelete", invalidate="nodes.")


def toggle_offline(client: CloudBeesClient, name: str, reason: str = "") -> None:
    """Mark a node offline (or online if already offline)."""
    client.post(
        f"/computer/{name}/toggleOffline",
        invalidate="nodes.",
        params={"offlineMessage": reason},
    )


def update_node(client: CloudBeesClient, name: str, xml_str: str) -> None:
    """Update node using a config.xml string."""
    client.post_xml(
        f"/computer/{name}/config.xml",
        xml_str=xml_str,
        invalidate="nodes.",
    )
