from __future__ import annotations
"""cb system commands."""

import click
from cb.services.auth_service import get_client
from cb.services.system_service import health_check, get_version
from cb.cache.manager import clear_all, purge_expired
from cb.cli.formatters import format_kv, format_json


@click.group("system")
def system_group():
    """System and server info."""


def _client(ctx):
    return get_client(
        profile_name=ctx.obj.get("profile"),
        password=ctx.obj.get("password"),
        db_path=ctx.obj.get("db_path"),
    )


@system_group.command("health")
@click.option("--output", "-o", default="table", type=click.Choice(["table", "json"]))
@click.pass_context
def cmd_health(ctx, output):
    """Show server health information."""
    try:
        info = health_check(_client(ctx))
        if output == "json":
            click.echo(format_json(info))
        else:
            click.echo(format_kv(info))
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@system_group.command("version")
@click.pass_context
def cmd_version(ctx):
    """Show CloudBees server version."""
    try:
        ver = get_version(_client(ctx))
        click.echo(f"Server: {ver}")
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@system_group.command("cache-clear")
@click.option("--expired-only", is_flag=True, default=False, help="Only purge expired entries")
@click.pass_context
def cmd_cache_clear(ctx, expired_only):
    """Clear the API response cache."""
    db = ctx.obj.get("db_path")
    if expired_only:
        n = purge_expired(db)
        click.echo(f"[OK] Purged {n} expired cache entries.")
    else:
        clear_all(db)
        click.echo("[OK] Cache cleared.")
