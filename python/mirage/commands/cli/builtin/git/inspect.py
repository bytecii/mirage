import asyncio
from io import BytesIO

from dulwich.config import ConfigFile
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.history import (LogFlags, parse_flags,
                                                     ref_commits, select)
from mirage.commands.cli.builtin.git.io import read_file
from mirage.commands.cli.builtin.git.revparse import resolve_commit
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.util import check_operands, escaped, fatal
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult


async def repo_config(inv: CLIInvocation[None], fl: FlagView) -> ConfigFile:
    doors = inv.doors or CLIDoors()
    _, location = await opened(fl, doors)
    assert doors.dispatch is not None
    return ConfigFile.from_file(
        BytesIO(await read_file(doors.dispatch,
                                f"{location.commondir}/config")))


async def remote(
        inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    try:
        check_operands(inv.texts, marked=escaped(inv.argv))
        cfg = await repo_config(inv, fl)
        lines = []
        for section in sorted(cfg.sections()):
            if len(section) != 2 or section[0] != b"remote":
                continue
            name = section[1].decode()
            if not fl.as_bool("verbose"):
                lines.append(name)
                continue
            values = list(cfg.items(section))
            urls = [v.decode() for k, v in values if k == b"url"]
            push = [v.decode() for k, v in values if k == b"pushurl"] or urls
            if urls:
                lines.append(f"{name}\t{urls[0]} (fetch)")
            lines.extend(f"{name}\t{url} (push)" for url in push)
        return ("".join(f"{line}\n" for line in lines).encode(), IOResult())
    except GitError as exc:
        return fatal(exc)


async def config(
        inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    try:
        cfg = await repo_config(inv, fl)
        key = inv.texts[0]
        parts = key.split(".")
        section = (parts[0].lower().encode(), ) if len(parts) == 2 else (
            parts[0].lower().encode(), ".".join(parts[1:-1]).encode())
        if not cfg.has_section(section):
            return None, IOResult(exit_code=1)
        values = [
            value for name, value in cfg.items(section)
            if name.lower() == parts[-1].lower().encode()
        ]
        return (values[-1] + b"\n",
                IOResult()) if values else (None, IOResult(exit_code=1))
    except GitError as exc:
        return fatal(exc)


def _show_refs(repo: BaseRepo, patterns: tuple[str, ...]) -> bytes:
    return "".join(f"{repo.refs[ref].decode()} {ref.decode()}\n"
                   for ref in sorted(repo.refs.allkeys())
                   if ref.startswith(b"refs/") and (not patterns or any(
                       ref.decode() == p or ref.decode().endswith('/' + p)
                       for p in patterns))).encode()


async def show_ref(
        inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    try:
        repo, _ = await opened(FlagView(inv.flags), inv.doors or CLIDoors())
        out = await asyncio.to_thread(_show_refs, repo, tuple(inv.texts))
        return out, IOResult(exit_code=0 if out else 1)
    except GitError as exc:
        return fatal(exc)


def _revisions(repo: BaseRepo, revisions: tuple[str, ...],
               flags: LogFlags) -> list[bytes]:
    starts = ref_commits(repo) if flags.all_refs else []
    starts.extend(resolve_commit(repo, rev) for rev in revisions)
    return [commit.id for commit in select(repo, starts, flags)]


async def rev_list(
        inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    try:
        check_operands(inv.texts, marked=escaped(inv.argv))
        repo, _ = await opened(fl, inv.doors or CLIDoors())
        flags = parse_flags(fl)
        if not inv.texts and not flags.all_refs:
            return None, IOResult(
                exit_code=129,
                stderr=b"usage: git rev-list [<options>] <commit>...\n")
        commits = await asyncio.to_thread(_revisions, repo, tuple(inv.texts),
                                          flags)
        return (f"{len(commits)}\n".encode() if fl.as_bool("count") else
                b"".join(oid + b"\n" for oid in commits)), IOResult()
    except GitError as exc:
        return fatal(exc)
