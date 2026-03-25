from __future__ import annotations
"""cb controller — list, info, select, current."""

import click
from cb.cli.formatters import format_table, format_kv


@click.group("controller")
def controller_group():
    """Select and manage CloudBees controllers."""


def _client(ctx):
    from cb.services.auth_service import get_client
    return get_client(profile_name=ctx.obj.get("profile"), use_controller=False)


@controller_group.command("list")
@click.pass_context
def cmd_list(ctx):
    """List all controllers on this CloudBees server."""
    from cb.services.controller_service import list_controllers, get_active_controller
    try:
        controllers = list_controllers(_client(ctx))
        active = get_active_controller(ctx.obj.get("db_path"))
        active_name = active[0] if active else None

        headers = ["Active", "Name", "Description", "Status"]
        rows = [
            [
                "*" if c.name == active_name else "",
                c.name,
                (c.description or "")[:40],
                "ONLINE" if c.online else "OFFLINE",
            ]
            for c in controllers
        ]
        click.echo(format_table(headers, rows))
        click.echo(f"  {len(controllers)} controller(s)")
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@controller_group.command("info")
@click.argument("name")
@click.pass_context
def cmd_info(ctx, name):
    """Show controller details and creation permissions."""
    from cb.services.controller_service import get_controller_capabilities
    import dataclasses
    try:
        caps = get_controller_capabilities(_client(ctx), name)
        click.echo(format_kv(dataclasses.asdict(caps)))
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@controller_group.command("select")
@click.argument("name")
@click.pass_context
def cmd_select(ctx, name):
    """Set the active controller for subsequent commands."""
    from cb.services.controller_service import list_controllers, select_controller
    try:
        client = _client(ctx)
        controllers = list_controllers(client)
        match = next((c for c in controllers if c.name == name), None)
        if not match:
            click.echo(f"[ERROR] Controller '{name}' not found.", err=True)
            raise SystemExit(1)
            
        url = match.url
        # Follow the CJOC redirect to obtain the public Ingress real URL
        real_url = client.resolve_redirect(url)
        if real_url:
            if "operations-center-sso-navigate" in real_url:
                real_url = real_url.split("operations-center-sso-navigate")[0]
            url = real_url
            
        select_controller(match.name, url, ctx.obj.get("db_path"))
        click.echo(f"[OK] Active controller: {match.name}")
        click.echo(f"     Resolved URL: {url}")
    except SystemExit:
        raise
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@controller_group.command("current")
@click.pass_context
def cmd_current(ctx):
    """Show the currently active controller."""
    from cb.services.controller_service import get_active_controller
    active = get_active_controller(ctx.obj.get("db_path"))
    if active:
        click.echo(f"Active controller: {active[0]}")
        click.echo(f"URL              : {active[1]}")
    else:
        click.echo("No active controller selected. Use: cb controller select <name>")
