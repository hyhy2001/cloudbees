"""bee — CloudBees CLI + TUI entry point."""

from __future__ import annotations
import os
import sys
import logging
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
from cb.cli.commands.sync import cmd_sync

__version__ = "0.2.0"


@click.group(invoke_without_command=True)
@click.version_option(__version__, prog_name="bee")
@click.option("--ui", is_flag=True, default=False, help="Launch the TUI interface")
@click.option("--profile", "-p", default=None, envvar="CB_PROFILE", help="Profile name to use")
@click.option("--controller", "-c", default=None, envvar="CB_CONTROLLER",
              help="Active controller name (overrides saved setting)")
@click.option("--token", default=None, envvar="CB_TOKEN",
              help="API Token (or set CB_TOKEN env var)")
@click.option("--debug", is_flag=True, default=False, help="Enable debug logging")
@click.option("--db", default=None, envvar="CB_DB_PATH",
              help="Override database path (for testing)")
@click.pass_context
def cli(ctx, ui, profile, controller, token, debug, db):
    """bee — CloudBees command-line tool.

    \b
    Usage:
      bee login                        # Interactive login
      bee controller list              # List controllers
      bee controller select <name>     # Select active controller
      bee job list                     # List jobs
      bee job create freestyle <name>  # Create a Freestyle job
      bee cred create --id x --username u  # Create credential
      bee node list                    # List agent nodes
      bee --ui                         # Launch TUI interface

    \b
    Environment variables:
    \b
    Environment variables:
      CB_PROFILE     Active profile name
      CB_CONTROLLER  Active controller name
      CB_TOKEN       API Token (avoid prompts in scripts)
      CB_DB_PATH     Custom database path
    """
    if debug:
        logging.basicConfig(level=logging.DEBUG, stream=sys.stderr, format="%(levelname)s %(name)s %(message)s")

    db_path = Path(db) if db else None
    if db_path:
        from cb.db.connection import set_db_path
        set_db_path(db_path)

    init_db(db_path)

    ctx.ensure_object(dict)
    ctx.obj["profile"] = profile
    ctx.obj["controller"] = controller
    ctx.obj["token"] = token
    ctx.obj["db_path"] = db_path
    ctx.obj["debug"] = debug

    if ui:
        _launch_tui(profile, controller, token, db_path)
        return

    if ctx.invoked_subcommand is None:
        click.echo(ctx.get_help())


def _launch_tui(profile, controller, token, db_path):
    """Bootstrap the curses TUI."""
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    try:
        import curses
        from cb.tui.app import main as tui_main
        curses.wrapper(
            tui_main,
            profile=profile,
            controller=controller,
            token=token,
            db_path=db_path,
        )
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        click.echo(f"[ERROR] TUI failed: {exc}", err=True)
        sys.exit(1)


# Register all command groups
cli.add_command(auth_group, name="auth")
cli.add_command(auth_group, name="login")   # intentional alias: `bee login` == `bee auth`
cli.add_command(controller_group, name="controller")
cli.add_command(jobs_group, name="job")
cli.add_command(cred_group, name="cred")
cli.add_command(node_group, name="node")
cli.add_command(users_group, name="users")
cli.add_command(system_group, name="system")
cli.add_command(cmd_sync, name="sync")


if __name__ == "__main__":
    cli()
