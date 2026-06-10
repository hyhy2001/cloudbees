from __future__ import annotations
"""cb node -- list, get, create, copy, delete, offline, online."""

import click
from cb.cli.console import console, print_error
from cb.cli.formatters import format_table, format_kv


@click.group("node")
def node_group():
    """Manage CloudBees agent nodes."""


def _client(ctx):
    from cb.services.auth_service import get_client
    from cb.cache.manager import invalidate_resource_cache
    
    client = get_client(profile_name=ctx.obj.get("profile"))
    
    # Invalidate node cache to ensure fresh data
    invalidate_resource_cache("node", client._db_path)
    
    return client


@node_group.command("list")
@click.option("--all", "show_all", is_flag=True, help="Show all nodes (by default, only shows yours)")
@click.pass_context
def cmd_list(ctx, show_all):
    """List agent nodes with online/offline status."""
    from cb.services.node_service import list_nodes
    from cb.db.repositories.resource_repo import get_tracked_resources
    try:
        all_nodes = list_nodes(_client(ctx))
        nodes = all_nodes
        
        if not show_all:
            profile_name = ctx.obj.get("profile") or "default"
            tracked = get_tracked_resources("node", profile_name, controller_name=_client(ctx).base_url)
            tracked_set = set(tracked)
            
            display_nodes = [n for n in all_nodes if n.name in tracked_set]
            server_names = {n.name for n in all_nodes}
            
            missing = tracked_set - server_names
            from cb.dtos.node import NodeDTO
            for m in list(missing):
                display_nodes.append(NodeDTO(name=m, offline=True, num_executors=0, labels="[DELETED_ON_SERVER]"))
            
            nodes = display_nodes
        headers = ["Name", "Status", "Executors", "Labels", "Description"]
        rows = [
            [
                n.name[:28],
                "OFFLINE" if n.offline else "ONLINE",
                str(n.num_executors),
                (n.labels or "")[:20],
                (n.description or "")[:25],
            ]
            for n in nodes
        ]
        console.print(format_table(headers, rows))
        console.print(f"  {len(nodes)} node(s)")
    except Exception as exc:
        print_error(str(exc), exc)
        raise SystemExit(1)


@node_group.command("get")
@click.argument("name")
@click.pass_context
def cmd_get(ctx, name):
    """Show node details."""
    from cb.services.node_service import get_node
    try:
        node = get_node(_client(ctx), name)
        data = {
            "name": node.name,
            "offline": node.offline,
            "executors": node.num_executors,
            "labels": node.labels,
            "launcher": node.launcher_type,
            "remote_dir": node.remote_dir,
            "description": node.description,
        }
        console.print(format_kv(data))
    except Exception as exc:
        print_error(str(exc), exc)
        raise SystemExit(1)


@node_group.command("create")
@click.option("--name", required=True, help="Node name")
@click.option("--remote-dir", required=True, help="Remote work directory (e.g. /home/jenkins)")
@click.option("--executors", default=1, show_default=True, help="Number of executors")
@click.option("--labels", default="", help="Space-separated labels")
@click.option("--description", default="", help="Description")
@click.option("--host", default="", help="SSH Host IP/Hostname (if omitted, creates JNLP/Inbound agent)")
@click.option("--port", default=22, show_default=True, help="SSH Port")
@click.option("--cred-id", default="", help="Credential ID for SSH connection")
@click.option(
    "--java-path", 
    default="/usr/local/java/openjdk-19.0.2-7/bin/java", 
    show_default=True, 
    help="Path to Java executable"
)


@click.pass_context
def cmd_create(ctx, name, remote_dir, executors, labels, description, host, port, cred_id, java_path):
    """Create a Permanent Agent (SSH or JNLP launcher)."""
    from cb.services.node_service import create_permanent_node, get_node
    try:
        # Check if node already exists
        try:
            get_node(_client(ctx), name)
            # Node exists
            console.print(f"[info]INFO[/info] Node '{name}' already exists.")
            return
        except Exception as e:
            # Continue only if the error is 404 (not found)
            if "404" not in str(e) and "not found" not in str(e).lower():
                raise e
            # Otherwise, node doesn't exist, continue with creation
        
        create_permanent_node(
            _client(ctx),
            name=name,
            remote_dir=remote_dir,
            num_executors=executors,
            labels=labels,
            desc=description,
            host=host,
            port=port,
            credentials_id=cred_id,
            java_path=java_path,
        )
        from cb.db.repositories.resource_repo import track_resource
        track_resource("node", name, ctx.obj.get("profile") or "default", controller_name=_client(ctx).base_url)
        console.print(f"[success]OK[/success] Node '{name}' created.")
        url = f"{_client(ctx).base_url.rstrip('/')}/computer/{name}/"
        console.print(f"  Link: {url}")
        if host:
            cred_display = cred_id or 'None'
            console.print(f"  SSH Node will auto-connect to {host}:{port} using cred: '{cred_display}'")
        else:
            console.print(f"  Connect it via: Manage Jenkins -> Nodes -> {name} -> Agent command")
    except Exception as exc:
        print_error(str(exc), exc)
        raise SystemExit(1)


@node_group.command("copy")
@click.argument("source_name")
@click.argument("new_name")
@click.pass_context
def cmd_copy(ctx, source_name, new_name):
    """Copy an existing node's configuration to a new node."""
    from cb.services.node_service import copy_node
    try:
        copy_node(_client(ctx), source_name, new_name)
        from cb.db.repositories.resource_repo import track_resource
        track_resource("node", new_name, ctx.obj.get("profile") or "default", controller_name=_client(ctx).base_url)
        console.print(f"[success]OK[/success] Node '{new_name}' created (copied from '{source_name}').")
    except Exception as exc:
        print_error(str(exc), exc)
        raise SystemExit(1)


@node_group.command("delete")
@click.argument("name")
@click.option("--yes", is_flag=True, default=False, help="Skip confirmation")
@click.pass_context
def cmd_delete(ctx, name, yes):
    """Delete a node."""
    from cb.services.node_service import delete_node
    try:
        if not yes:
            click.confirm(f"Delete node '{name}'?", abort=True)
        delete_node(_client(ctx), name)
        from cb.db.repositories.resource_repo import untrack_resource
        untrack_resource("node", name, ctx.obj.get("profile") or "default", controller_name=_client(ctx).base_url)
        console.print(f"[success]OK[/success] Node '{name}' deleted.")
    except click.Abort:
        console.print("Cancelled.")
    except Exception as exc:
        print_error(str(exc), exc)
        raise SystemExit(1)


@node_group.command("offline")
@click.argument("name")
@click.option("--reason", default="", help="Reason for taking offline")
@click.pass_context
def cmd_offline(ctx, name, reason):
    """Mark a node as offline."""
    from cb.services.node_service import toggle_offline
    try:
        toggle_offline(_client(ctx), name, reason)
        console.print(f"[success]OK[/success] Node '{name}' toggled offline.")
    except Exception as exc:
        print_error(str(exc), exc)
        raise SystemExit(1)


@node_group.command("online")
@click.argument("name")
@click.pass_context
def cmd_online(ctx, name):
    """Bring a node back online (toggle offline off)."""
    from cb.services.node_service import toggle_offline
    try:
        toggle_offline(_client(ctx), name, "")
        console.print(f"[success]OK[/success] Node '{name}' toggled online.")
    except Exception as exc:
        print_error(str(exc), exc)
        raise SystemExit(1)


@node_group.command("update")
@click.argument("name")
@click.option("--description", default=None, help="Node description")
@click.option("--remote-dir", default=None, help="Remote root directory (e.g. /home/jenkins)")
@click.option("--executors", type=int, default=None, help="Number of executors")
@click.option("--labels", default=None, help="Labels (space separated)")
@click.pass_context
def cmd_update(ctx, name, description, remote_dir, executors, labels):
    """Update a node's configuration."""
    from cb.services.node_service import update_node
    try:
        update_node(
            _client(ctx), 
            name, 
            remote_dir=remote_dir, 
            num_executors=executors, 
            labels=labels, 
            desc=description
        )
        console.print(f"[success]OK[/success] Node '{name}' updated.")
    except Exception as exc:
        print_error(str(exc), exc)
        raise SystemExit(1)
