from __future__ import annotations
"""Node / Agent service — list, get, create, copy, delete, toggle offline."""

from pathlib import Path
from typing import Optional, List

from cb.api.client import CloudBeesClient
from cb.api.xml_builder import build_permanent_node_xml, patch_node_xml
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
) -> None:
    """Create a Permanent Agent with JNLP launcher."""
    xml = build_permanent_node_xml(
        name=name,
        remote_dir=remote_dir,
        num_executors=num_executors,
        labels=labels,
        desc=desc,
    )
    client.post_xml(
        "/computer/doCreateItem",
        xml_str=xml,
        invalidate="nodes.",
        params={"name": name, "type": "hudson.slaves.DumbSlave"},
    )


def copy_node(
    client: CloudBeesClient, 
    source_name: str, 
    new_name: str,
) -> None:
    """Copy an existing node's config and register it with a new name."""
    # Fetch source XML
    source_xml = client.get_text(f"/computer/{source_name}/config.xml")
    # Patch name in XML
    new_xml = patch_node_xml(source_xml, new_name)
    # Create new node
    client.post_xml(
        "/computer/doCreateItem",
        xml_str=new_xml,
        invalidate="nodes.",
        params={"name": new_name, "type": "hudson.slaves.DumbSlave"},
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
