"""cb jobs commands."""

from __future__ import annotations
import click
from cb.services.auth_service import get_client
from cb.services.job_service import list_jobs, get_job, trigger_job, stop_job, get_build
from cb.cli.formatters import format_table, format_json, format_kv


@click.group("jobs")
def jobs_group():
    """Manage CloudBees jobs."""


def _make_client(ctx):
    pwd = ctx.obj.get("password")
    profile = ctx.obj.get("profile")
    return get_client(profile_name=profile, password=pwd, db_path=ctx.obj.get("db_path"))


@jobs_group.command("list")
@click.option("--output", "-o", default="table", type=click.Choice(["table", "json"]))
@click.pass_context
def cmd_list(ctx, output):
    """List all jobs."""
    try:
        client = _make_client(ctx)
        jobs = list_jobs(client)
        if output == "json":
            click.echo(format_json([j.to_dict() for j in jobs]))
        else:
            rows = [[j.name, j.color, str(j.last_build_number or "-"), j.description[:40]]
                    for j in jobs]
            click.echo(format_table(["Name", "Status", "Build#", "Description"], rows))
            click.echo(f"  {len(jobs)} job(s)")
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@jobs_group.command("get")
@click.argument("name")
@click.option("--output", "-o", default="table", type=click.Choice(["table", "json"]))
@click.pass_context
def cmd_get(ctx, name, output):
    """Show details for a specific job."""
    try:
        client = _make_client(ctx)
        job = get_job(client, name)
        if output == "json":
            click.echo(format_json(job.to_dict()))
        else:
            click.echo(format_kv(job.to_dict()))
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@jobs_group.command("run")
@click.argument("name")
@click.pass_context
def cmd_run(ctx, name):
    """Trigger a job build."""
    try:
        client = _make_client(ctx)
        msg = trigger_job(client, name)
        click.echo(f"[OK] {msg}")
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@jobs_group.command("stop")
@click.argument("name")
@click.argument("build", type=int)
@click.pass_context
def cmd_stop(ctx, name, build):
    """Stop a running build."""
    try:
        client = _make_client(ctx)
        stop_job(client, name, build)
        click.echo(f"[OK] Stop requested for {name} #{build}")
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)
