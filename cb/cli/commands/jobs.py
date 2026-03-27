from __future__ import annotations
"""cb job -- full job management: list, get, create, delete, run, stop, log, status."""

import sys
import time
import datetime

import click
from cb.cli.formatters import format_table, format_kv


@click.group("job")
def jobs_group():
    """Manage CloudBees jobs (Freestyle, Pipeline, Folder)."""


def _client(ctx):
    from cb.services.auth_service import get_client
    from cb.cache.manager import invalidate_resource_cache
    
    client = get_client(profile_name=ctx.obj.get("profile"))
    
    # Invalidate job cache to ensure fresh data
    invalidate_resource_cache("job", client._db_path)
    
    return client


# -- list ------------------------------------------------------


@jobs_group.command("list")
@click.option("--all", "show_all", is_flag=True, help="Show all jobs (by default, only shows yours)")
@click.pass_context
def cmd_list(ctx, show_all):
    """List all jobs with type and last build status."""
    from cb.services.job_service import list_jobs
    from cb.db.repositories.resource_repo import get_tracked_resources
    try:
        all_jobs = list_jobs(_client(ctx))
        jobs = all_jobs
        
        if not show_all:
            profile_name = ctx.obj.get("profile") or "default"
            tracked = get_tracked_resources("job", profile_name, controller_name=_client(ctx).base_url)
            tracked_set = set(tracked)
            
            display_jobs = [j for j in all_jobs if j.name in tracked_set]
            server_names = {j.name for j in all_jobs}
            
            missing = tracked_set - server_names
            from cb.dtos.job import JobDTO
            for m in list(missing):
                display_jobs.append(JobDTO(name=m, url="", color="[DELETED_ON_SERVER]"))
            
            jobs = display_jobs
        headers = ["Name", "Type", "Status", "Build#", "Description"]
        def _map_color(color: str) -> str:
            base = color.replace("_anime", "")
            is_running = "_anime" in color
            state = {
                "blue": "OK",
                "red": "FAIL",
                "yellow": "WARN",
                "aborted": "ABORTED",
                "notbuilt": "NEW",
                "disabled": "DISABLED",
            }.get(base, base.upper() if base else "UNKNOWN")
            return f"{state} (Run)" if is_running else state

        rows = [
            [
                j.name[:30],
                j.job_type or "?",
                _map_color(j.color)[:14],
                str(j.last_build_number or "-"),
                (j.description or "")[:30],
            ]
            for j in jobs
        ]
        click.echo(format_table(headers, rows))
        click.echo(f"  {len(jobs)} job(s)  [FS=Freestyle  PL=Pipeline  FD=Folder]")
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


# -- get -------------------------------------------------------


@jobs_group.command("get")
@click.argument("name")
@click.pass_context
def cmd_get(ctx, name):
    """Show job details and last build info."""
    from cb.services.job_service import get_job
    try:
        job = get_job(_client(ctx), name)
        data = job.to_dict()
        click.echo(format_kv(data))
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


# -- create ----------------------------------------------------


@jobs_group.group("create")
def cmd_create():
    """Create a new job."""


@cmd_create.command("freestyle")
@click.argument("name")
@click.option("--description", default="", help="Job description")
@click.option("--shell", default=None, help="Shell command to run")
@click.option("--chdir", default=None, help="Working directory for the script")
@click.option("--node", default=None, help="Restrict job to a specific node/label")
@click.pass_context
def create_freestyle(ctx, name, description, shell, chdir, node):
    """Create a Freestyle project."""
    from cb.services.job_service import create_freestyle_job
    try:
        if not shell:
            shell = click.prompt("Shell command", default="echo hello")
        create_freestyle_job(_client(ctx), name=name, desc=description, shell_cmd=shell, chdir=chdir, node=node)
        from cb.db.repositories.resource_repo import track_resource
        track_resource("job", name, ctx.obj.get("profile") or "default", controller_name=_client(ctx).base_url)
        click.echo(f"[OK] Freestyle job '{name}' created." + (f" on node '{node}'" if node else ""))
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@cmd_create.command("pipeline")
@click.argument("name")
@click.option("--description", default="", help="Job description")
@click.option("--script", default=None, help="Inline Pipeline script")
@click.option("--script-file", default=None, type=click.Path(exists=True), help="Read script from file")
@click.option("--node", default=None, help="Restrict job to a specific node/label")
@click.pass_context
def create_pipeline(ctx, name, description, script, script_file, node):
    """Create a Pipeline job."""
    from cb.services.job_service import create_pipeline_job
    try:
        if script_file:
            with open(script_file, "r") as f:
                script = f.read()
        elif not script:
            click.echo("Enter Pipeline script (end with a line containing only '---'):")
            lines = []
            while True:
                line = click.prompt("", default="", prompt_suffix="")
                if line == "---":
                    break
                lines.append(line)
            script = "\n".join(lines)
        create_pipeline_job(_client(ctx), name=name, desc=description, script=script, node=node)
        from cb.db.repositories.resource_repo import track_resource
        track_resource("job", name, ctx.obj.get("profile") or "default", controller_name=_client(ctx).base_url)
        click.echo(f"[OK] Pipeline job '{name}' created." + (f" on node '{node}'" if node else ""))
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@cmd_create.command("folder")
@click.argument("name")
@click.option("--description", default="", help="Folder description")
@click.pass_context
def create_folder(ctx, name, description):
    """Create a Folder."""
    from cb.services.job_service import create_folder
    try:
        create_folder(_client(ctx), name=name, desc=description)
        from cb.db.repositories.resource_repo import track_resource
        track_resource("job", name, ctx.obj.get("profile") or "default", controller_name=_client(ctx).base_url)
        click.echo(f"[OK] Folder '{name}' created.")
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


# -- delete ----------------------------------------------------


@jobs_group.command("delete")
@click.argument("name")
@click.option("--yes", is_flag=True, default=False, help="Skip confirmation")
@click.pass_context
def cmd_delete(ctx, name, yes):
    """Delete a job or folder."""
    from cb.services.job_service import delete_job
    from cb.db.repositories.resource_repo import untrack_resource
    from cb.api.exceptions import NotFoundError, APIError
    
    try:
        if not yes:
            click.confirm(f"Delete job '{name}'?", abort=True)
        
        client = _client(ctx)
        
        # Try to delete on server
        try:
            delete_job(client, name)
            click.echo(f"[OK] Job '{name}' deleted from server.")
        except Exception as e:
            # If 404, job doesn't exist on server
            if "404" in str(e):
                click.echo(f"[INFO] Job '{name}' not found on server, removing from local tracking only.")
            # For other errors, show the error but still remove from local tracking
            else:
                click.echo(f"[WARN] Could not delete job on server: {e}")
                click.echo("Proceeding with local removal anyway.")
        
        # Always remove from local tracking
        untrack_resource("job", name, ctx.obj.get("profile") or "default", controller_name=_client(ctx).base_url)
        click.echo(f"[OK] Job '{name}' removed from local database.")
        
    except click.Abort:
        click.echo("Cancelled.")
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


# -- run -------------------------------------------------------


@jobs_group.command("run")
@click.argument("name")
@click.option("--wait", is_flag=True, default=False, help="Wait for build to finish")
@click.option("--timeout", default=120, show_default=True, help="Max wait time in seconds")
@click.pass_context
def cmd_run(ctx, name, wait, timeout):
    """Trigger a job build."""
    from cb.services.job_service import (
        trigger_job, get_last_build_number, wait_for_build
    )
    
    try:
        client = _client(ctx)
        
        # Try to capture build number before triggering
        before = 0
        if wait:
            try:
                before = get_last_build_number(client, name) or 0
            except Exception as e:
                # If we can't get the last build number, just use 0
                click.echo(f"[WARN] Could not get current build number: {e}")
                click.echo("Will use 0 as reference.")
                before = 0
        
        # Try to trigger the job
        try:
            trigger_job(client, name)
            click.echo(f"[OK] Triggered: {name}")
        except Exception as e:
            # Just show error without removing from local tracking
            click.echo(f"[ERROR] Could not trigger job: {e}")
            return

        if not wait:
            return

        # Wait for new build to appear (up to 15s)
        click.echo("  Waiting for build to start...", nl=False)
        deadline = time.time() + 15
        new_build_num = None
        while time.time() < deadline:
            try:
                current = get_last_build_number(client, name)
                if current and current > before:
                    new_build_num = current
                    break
            except Exception:
                # If we can't get the build number, just continue polling
                pass
            time.sleep(2)
            click.echo(".", nl=False)
        click.echo()

        if not new_build_num:
            click.echo("  Could not determine build number. Check Jenkins manually.")
            return

        click.echo(f"  Build #{new_build_num} -- waiting for completion (timeout={timeout}s)...")
        try:
            build = wait_for_build(client, name, new_build_num, timeout=timeout)
            result = build.result or "IN_PROGRESS"
            click.echo(f"  Result: {result}")
        except Exception as e:
            click.echo(f"[ERROR] Error while waiting for build: {e}")
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


# -- stop ------------------------------------------------------


@jobs_group.command("stop")
@click.argument("name")
@click.argument("build_number", type=int)
@click.pass_context
def cmd_stop(ctx, name, build_number):
    """Stop a running build."""
    from cb.services.job_service import stop_build
    try:
        stop_build(_client(ctx), name, build_number)
        click.echo(f"[OK] Stop requested: {name} #{build_number}")
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


# -- log -------------------------------------------------------


@jobs_group.command("log")
@click.argument("name")
@click.argument("build_number", type=int, required=False, default=None)
@click.option("--follow", "-f", is_flag=True, default=False,
              help="Stream log (poll every 3s until build completes)")
@click.pass_context
def cmd_log(ctx, name, build_number, follow):
    """Print console log for a build (default: last build)."""
    from cb.services.job_service import (
        get_build_log, get_last_build_number, get_build_detail
    )
    
    try:
        client = _client(ctx)
        
        # If build number is not provided, try to get the last build number
        if build_number is None:
            try:
                build_number = get_last_build_number(client, name)
                if build_number is None:
                    click.echo("No builds found.")
                    return
            except Exception as e:
                # Just show error without removing from local tracking
                click.echo(f"[ERROR] Could not get last build number: {e}")
                return

        # Try to get the log
        try:
            if not follow:
                log = get_build_log(client, name, build_number)
                click.echo(log)
                return
            
            # Follow mode -- poll until done
            shown = 0
            while True:
                log = get_build_log(client, name, build_number)
                new_content = log[shown:]
                if new_content:
                    click.echo(new_content, nl=False)
                    shown = len(log)
                build = get_build_detail(client, name, build_number)
                if not build.building:
                    break
                time.sleep(3)
        except Exception as e:
            # Just show error without removing from local tracking
            click.echo(f"[ERROR] Could not get build log: {e}")
            return
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


# -- status ----------------------------------------------------


@jobs_group.command("status")
@click.argument("name")
@click.option("--count", default=10, show_default=True, help="Number of recent builds to show")
@click.pass_context
def cmd_status(ctx, name, count):
    """Show recent build history for a job."""
    from cb.services.job_service import get_build_history
    try:
        builds = get_build_history(_client(ctx), name, count=count)
        if not builds:
            click.echo("No builds found.")
            return

        headers = ["Build#", "Result", "Duration", "Timestamp"]
        rows = []
        for b in builds:
            ts = datetime.datetime.fromtimestamp(b.timestamp / 1000).strftime("%Y-%m-%d %H:%M") if b.timestamp else "-"
            dur = f"{b.duration // 1000}s" if b.duration else "-"
            result = b.result if b.result else ("RUNNING" if b.building else "-")
            rows.append([str(b.number), result, dur, ts])

        click.echo(format_table(headers, rows))
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@jobs_group.command("update")
@click.argument("name")
@click.argument("xml_file", type=click.File("r"))
@click.pass_context
def cmd_update(ctx, name, xml_file):
    """Update a job using a config.xml file."""
    from cb.services.job_service import update_job
    try:
        update_job(_client(ctx), name, xml_file.read())
        click.echo(f"[OK] Job '{name}' updated.")
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)
