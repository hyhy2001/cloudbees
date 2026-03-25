from __future__ import annotations
"""Node / Agent service — list, get, create, copy, delete, toggle offline."""

from pathlib import Path
from typing import Optional, List

from cb.api.client import CloudBeesClient
from cb.api.xml_builder import build_permanent_node_xml, patch_node_xml
from cb.dtos.node import NodeDTO, NodeDetailDTO

_NODE_TREE = "computer[displayName,offline,numExecutors,assignedLabels[name],description]"


def _computer_base(db_path: Optional[Path] = None, controller_name: Optional[str] = None) -> str:
    """Return /computer base path scoped to active controller.

    No controller -> /cjoc/computer
    Controller    -> /<ctrl>/computer
    """
    ctrl = controller_name
    if ctrl is None and db_path is not None:
        from cb.services.controller_service import get_active_controller
        active = get_active_controller(db_path)
        ctrl   = active[0] if active else None
    
    return f"/{ctrl}/computer" if ctrl else "/computer"


def list_nodes(
    client: CloudBeesClient,
    db_path: Optional[Path] = None,
    controller_name: Optional[str] = None,
) -> List[NodeDTO]:
    base      = _computer_base(db_path, controller_name)
    cache_key = f"nodes.list.{controller_name or '_root'}"
    data = client.get(
        f"{base}/api/json?tree={_NODE_TREE}",
        cache_key=cache_key,
    )
    computers = (data or {}).get("computer", [])
    return [NodeDTO.from_dict(c) for c in computers]


def get_node(
    client: CloudBeesClient,
    name: str,
    db_path: Optional[Path] = None,
    controller_name: Optional[str] = None,
) -> NodeDetailDTO:
    base = _computer_base(db_path, controller_name)
    data = client.get(
        f"{base}/{name}/api/json",
        cache_key=f"nodes.detail.{name}",
    )
    dto = NodeDetailDTO.from_dict(data or {})
    try:
        xml        = client.get_text(f"{base}/{name}/config.xml")
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


def copy_node(client: CloudBeesClient, source_name: str, new_name: str) -> None:
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
    client.post(
        f"/computer/{name}/doDelete",
        invalidate="nodes.",
    )


def toggle_offline(
    client: CloudBeesClient,
    name: str,
    reason: str = "",
    db_path: Optional[Path] = None,
    controller_name: Optional[str] = None,
) -> None:
    """Mark a node offline (or online if already offline)."""
    base = _computer_base(db_path, controller_name)
    client.post(
        f"{base}/{name}/toggleOffline",
        invalidate="nodes.",
        params={"offlineMessage": reason},
    )
