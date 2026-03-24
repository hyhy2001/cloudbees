from __future__ import annotations
"""cb controller — list, info, select, current."""

import click
from cb.cli.formatters import format_table, format_kv, format_json


@click.group("controller")
def controller_group():
    """Select and manage CloudBees controllers."""


def _client(ctx):
    from cb.services.auth_service import get_client
    return get_client(
        profile_name=ctx.obj.get("profile"),
        password=ctx.obj.get("password"),
        db_path=ctx.obj.get("db_path"),
    )


@controller_group.command("list")
@click.option("--output", "-o", default="table", type=click.Choice(["table", "json"]))
@click.pass_context
def cmd_list(ctx, output):
    """List all controllers on this CloudBees server."""
    from cb.services.controller_service import list_controllers, get_active_controller
    try:
        controllers = list_controllers(_client(ctx))
        active = get_active_controller(ctx.obj.get("db_path"))
        active_name = active[0] if active else None

        if output == "json":
            click.echo(format_json([c.to_dict() for c in controllers]))
            return

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
@click.option("--output", "-o", default="table", type=click.Choice(["table", "json"]))
@click.pass_context
def cmd_info(ctx, name, output):
    """Show controller details."""
    from cb.services.controller_service import get_controller
    try:
        ctrl = get_controller(_client(ctx), name)
        if output == "json":
            click.echo(format_json(ctrl.to_dict()))
        else:
            click.echo(format_kv(ctrl.to_dict()))
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
        controllers = list_controllers(_client(ctx))
        match = next((c for c in controllers if c.name == name), None)
        if not match:
            click.echo(f"[ERROR] Controller '{name}' not found.", err=True)
            raise SystemExit(1)
        select_controller(match.name, match.url, ctx.obj.get("db_path"))
        click.echo(f"[OK] Active controller: {match.name} ({match.url})")
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
