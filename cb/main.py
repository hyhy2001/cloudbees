"""cb — CloudBees CLI + TUI entry point."""

from __future__ import annotations
import os
import sys
from pathlib import Path

import click

from cb.db.connection import init_db
from cb.cli.commands.auth import auth_group
from cb.cli.commands.jobs import jobs_group
from cb.cli.commands.controller import controller_group
from cb.cli.commands.credentials import cred_group
from cb.cli.commands.nodes import node_group
from cb.cli.commands.users import users_group
from cb.cli.commands.system import system_group

__version__ = "0.2.0"


@click.group(invoke_without_command=True)
@click.version_option(__version__, prog_name="cb")
@click.option("--ui", is_flag=True, default=False, help="Launch the TUI interface")
@click.option("--profile", "-p", default=None, envvar="CB_PROFILE", help="Profile name to use")
@click.option("--controller", "-c", default=None, envvar="CB_CONTROLLER",
              help="Active controller name (overrides saved setting)")
@click.option("--password", default=None, envvar="CB_PASSWORD",
              help="Master password (or set CB_PASSWORD env var)")
@click.option("--db", default=None, envvar="CB_DB_PATH",
              help="Override database path (for testing)")
@click.pass_context
def cli(ctx, ui, profile, controller, password, db):
    """cb — CloudBees command-line tool.

    \b
    Usage:
      cb login                        # Interactive login
      cb controller list              # List controllers
      cb controller select <name>     # Select active controller
      cb job list                     # List jobs
      cb job create freestyle <name>  # Create a Freestyle job
      cb cred create --id x --username u  # Create credential
      cb node list                    # List agent nodes
      cb --ui                         # Launch TUI interface

    \b
    Environment variables:
      CB_PROFILE     Active profile name
      CB_CONTROLLER  Active controller name
      CB_PASSWORD    Master password (avoid prompts in scripts)
      CB_DB_PATH     Custom database path
    """
    db_path = Path(db) if db else None
    if db_path:
        from cb.db.connection import set_db_path
        set_db_path(db_path)

    init_db(db_path)

    ctx.ensure_object(dict)
    ctx.obj["profile"] = profile
    ctx.obj["controller"] = controller
    ctx.obj["password"] = password
    ctx.obj["db_path"] = db_path

    if ui:
        _launch_tui(profile, controller, password, db_path)
        return

    if ctx.invoked_subcommand is None:
        click.echo(ctx.get_help())


def _launch_tui(profile, controller, password, db_path):
    """Bootstrap the curses TUI."""
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    try:
        import curses
        from cb.tui.app import main as tui_main
        curses.wrapper(
            tui_main,
            profile=profile,
            controller=controller,
            password=password,
            db_path=db_path,
        )
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        click.echo(f"[ERROR] TUI failed: {exc}", err=True)
        sys.exit(1)


# Register all command groups
cli.add_command(auth_group, name="auth")
cli.add_command(auth_group, name="login")
cli.add_command(controller_group, name="controller")
cli.add_command(jobs_group, name="job")
cli.add_command(cred_group, name="cred")
cli.add_command(node_group, name="node")
cli.add_command(users_group, name="users")
cli.add_command(system_group, name="system")


if __name__ == "__main__":
    cli()
