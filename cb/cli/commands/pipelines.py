from __future__ import annotations
"""cb pipeline commands."""

import click
from cb.services.auth_service import get_client
from cb.services.pipeline_service import list_pipelines, run_pipeline, get_run_status
from cb.cli.formatters import format_table, format_json


@click.group("pipeline")
def pipeline_group():
    """Manage CloudBees pipelines."""


def _client(ctx):
    return get_client(
        profile_name=ctx.obj.get("profile"),
        password=ctx.obj.get("password"),
        db_path=ctx.obj.get("db_path"),
    )


@pipeline_group.command("list")
@click.option("--output", "-o", default="table", type=click.Choice(["table", "json"]))
@click.pass_context
def cmd_list(ctx, output):
    """List all pipelines."""
    try:
        pipes = list_pipelines(_client(ctx))
        if output == "json":
            click.echo(format_json([p.to_dict() for p in pipes]))
        else:
            rows = [[p.name, p.status, p.branch, p.description[:40]] for p in pipes]
            click.echo(format_table(["Name", "Status", "Branch", "Description"], rows))
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@pipeline_group.command("run")
@click.argument("name")
@click.pass_context
def cmd_run(ctx, name):
    """Trigger a pipeline run."""
    try:
        msg = run_pipeline(_client(ctx), name)
        click.echo(f"[OK] {msg}")
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)
