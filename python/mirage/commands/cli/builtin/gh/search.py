import json
import re
from functools import partial
from typing import Any

from mirage.commands.cli.builtin.gh.accessor import (csv_values, json_fields,
                                                     text_out, typed_out)
from mirage.commands.cli.builtin.gh.template import render_template
from mirage.commands.cli.types import CLIInvocation, CLISpec
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import Operand, Option
from mirage.core.github.config import GhConfig
from mirage.core.github.search import search
from mirage.io.types import CommandOutput

FLAGS = {
    'issues': [
        'app', 'archived', 'assignee', 'author', 'closed', 'commenter',
        'comments', 'created', 'interactions', 'involves', 'label', 'language',
        'locked', 'match', 'mentions', 'milestone', 'no-assignee', 'no-label',
        'no-milestone', 'no-project', 'owner', 'project', 'reactions', 'repo',
        'state', 'team-mentions', 'updated', 'visibility', 'include-prs'
    ],
    'prs': [
        'app', 'archived', 'assignee', 'author', 'closed', 'commenter',
        'comments', 'created', 'interactions', 'involves', 'label', 'language',
        'locked', 'match', 'mentions', 'milestone', 'no-assignee', 'no-label',
        'no-milestone', 'no-project', 'owner', 'project', 'reactions', 'repo',
        'state', 'team-mentions', 'updated', 'visibility', 'base', 'checks',
        'draft', 'head', 'merged', 'merged-at', 'review', 'review-requested',
        'reviewed-by'
    ],
    'repos': [
        'archived', 'created', 'followers', 'forks', 'good-first-issues',
        'help-wanted-issues', 'include-forks', 'language', 'license', 'match',
        'number-topics', 'owner', 'size', 'stars', 'topic', 'updated',
        'visibility'
    ],
    'code':
    ['extension', 'filename', 'language', 'match', 'owner', 'repo', 'size'],
    'commits': [
        'author', 'author-date', 'author-email', 'author-name', 'committer',
        'committer-date', 'committer-email', 'committer-name', 'hash', 'merge',
        'owner', 'parent', 'repo', 'tree', 'visibility'
    ]
}
MULTIPLE = [
    'label', 'match', 'owner', 'repo', 'visibility', 'license', 'topic'
]
BOOLEAN = [
    'archived', 'draft', 'merge', 'locked', 'merged', 'include-prs',
    'no-assignee', 'no-label', 'no-milestone', 'no-project'
]
ALIASES = {
    'owner': 'user',
    'match': 'in',
    'visibility': 'is',
    'team-mentions': 'team',
    'checks': 'status',
    'merged-at': 'merged',
    'number-topics': 'topics',
    'include-forks': 'fork'
}
SORTS = {
    'issues': [
        'comments', 'created', 'interactions', 'reactions', 'reactions-+1',
        'reactions--1', 'reactions-heart', 'reactions-smile', 'reactions-tada',
        'reactions-thinking_face', 'updated'
    ],
    'prs': [
        'comments', 'created', 'interactions', 'reactions', 'reactions-+1',
        'reactions--1', 'reactions-heart', 'reactions-smile', 'reactions-tada',
        'reactions-thinking_face', 'updated'
    ],
    'repos': ['forks', 'help-wanted-issues', 'stars', 'updated'],
    'commits': ['author-date', 'committer-date']
}
FIELDS = {
    'issues': [
        'assignees', 'author', 'authorAssociation', 'body', 'closedAt',
        'commentsCount', 'createdAt', 'id', 'isLocked', 'isPullRequest',
        'labels', 'number', 'repository', 'state', 'title', 'updatedAt', 'url'
    ],
    'prs': [
        'assignees', 'author', 'authorAssociation', 'body', 'closedAt',
        'commentsCount', 'createdAt', 'id', 'isLocked', 'isPullRequest',
        'labels', 'number', 'repository', 'state', 'title', 'updatedAt', 'url',
        'isDraft'
    ],
    'repos': [
        'createdAt', 'defaultBranch', 'description', 'forksCount', 'fullName',
        'hasDownloads', 'hasIssues', 'hasPages', 'hasProjects', 'hasWiki',
        'homepage', 'id', 'isArchived', 'isDisabled', 'isFork', 'isPrivate',
        'language', 'license', 'name', 'openIssuesCount', 'owner', 'pushedAt',
        'size', 'stargazersCount', 'updatedAt', 'url', 'visibility',
        'watchersCount'
    ],
    'code': ['path', 'repository', 'sha', 'textMatches', 'url'],
    'commits': [
        'author', 'commit', 'committer', 'sha', 'id', 'parents', 'repository',
        'url'
    ]
}


def _quote(value: str) -> str:
    return json.dumps(value, ensure_ascii=False) if re.search(r'[\s"]',
                                                              value) else value


def _boolean(fl: FlagView, name: str) -> bool:
    name = name.replace("-", "_")
    return fl.as_bool(name) or fl.as_str(name) == "true"


def _query(kind: str, words: tuple[str, ...], fl: FlagView) -> str:
    qualifiers: dict[str, list[str]] = {}
    for name in FLAGS[kind]:
        value = fl.raw(name.replace("-", "_"))
        if value is None or name in ("app", "include-prs", "locked",
                                     "merged") or name.startswith("no-"):
            continue
        key = ALIASES.get(name, name)
        if name == "review-requested" and isinstance(value,
                                                     str) and "/" in value:
            key = "team-review-requested"
        if name in BOOLEAN:
            values = [str(_boolean(fl, name)).lower()]
        elif name in MULTIPLE:
            values = csv_values(fl.as_list(name.replace("-", "_")))
        else:
            values = [fl.as_str(name.replace("-", "_")) or ""]
        qualifiers.setdefault(key, []).extend(v for v in values if v)
    if kind in ("issues", "prs"):
        if kind == "prs" or not _boolean(fl, "include_prs"):
            qualifiers["type"] = ["pr" if kind == "prs" else "issue"]
        if fl.as_str("app") is not None:
            if fl.as_str("author") is not None:
                raise UsageError("specify only `--author` or `--app`", 1)
            qualifiers["author"] = ["app/" + (fl.as_str("app") or "")]
        for name in (("locked", "merged") if kind == "prs" else ("locked", )):
            if fl.raw(name) is not None:
                qualifiers.setdefault(
                    "is",
                    []).append(name if _boolean(fl, name) else "un" + name)
        qualifiers["no"] = [
            name for name in ("assignee", "label", "milestone", "project")
            if _boolean(fl, "no_" + name)
        ]
    keywords = []
    for word in words:
        head, colon, tail = word.partition(":")
        keywords.append(head + ":" + _quote(tail) if colon else _quote(word))
    return " ".join(keywords + sorted(f"{key}:{_quote(v)}"
                                      for key, values in qualifiers.items()
                                      for v in values))


def _option(name: str) -> Option:
    choices = {
        "state": ("open", "closed"),
        "include-forks": ("false", "true", "only"),
        "checks": ("pending", "success", "failure"),
        "review": ("none", "required", "approved", "changes_requested")
    }.get(name, ())
    return Option(long="--" + name,
                  short={
                      "repo": "-R",
                      "base": "-B",
                      "head": "-H"
                  }.get(name),
                  type="str",
                  multiple=name in MULTIPLE,
                  value_optional=name in BOOLEAN,
                  choices=("true", "false") if name in BOOLEAN else choices)


def search_spec() -> CLISpec:
    leaves = []
    for kind in FLAGS:
        options = [_option(name) for name in FLAGS[kind]]
        options.extend(
            (Option(long="--json",
                    type="str"), Option(long="--jq", short="-q", type="str"),
             Option(long="--template", short="-t", type="str"),
             Option(long="--limit", short="-L", type="int", default="30")))
        if kind in SORTS:
            options.extend((Option(long="--sort",
                                   type="str",
                                   choices=tuple(SORTS[kind])),
                            Option(long="--order",
                                   type="str",
                                   choices=("asc", "desc"))))
        leaves.append(
            CLISpec(name=kind,
                    description=f"Search for {kind}",
                    fn=partial(search_cmd, kind),
                    rest=Operand(type="str", name="QUERY"),
                    options=tuple(options)))
    return CLISpec(name="search",
                   description="Search GitHub",
                   subcommands=tuple(leaves))


async def search_cmd(kind: str, inv: CLIInvocation[GhConfig]) -> CommandOutput:
    fl = FlagView(inv.flags, inv.spec)
    fields = json_fields(fl, FIELDS[kind])
    limit = fl.as_int("limit")
    if limit is None or limit < 1 or limit > 1000:
        raise UsageError("`--limit` must be between 1 and 1000", 1)
    if not inv.texts and len(inv.argv) <= 2:
        raise UsageError("specify search keywords or flags", 1)
    if fields is None and (fl.as_str("jq") is not None
                           or fl.as_str("template") is not None):
        raise UsageError("cannot use `--jq` or `--template` without `--json`",
                         1)
    if fl.as_str("jq") is not None and fl.as_str("template") is not None:
        raise UsageError("cannot use `--jq` and `--template` together", 1)
    values = await search(inv.config, {
        "repos": "repositories",
        "prs": "issues"
    }.get(kind, kind), _query(kind, inv.texts, fl), limit,
                          fl.as_str("sort") if kind in SORTS else None,
                          fl.as_str("order") if kind in SORTS else None)
    rows = [_export(kind, value) for value in values]
    template = fl.as_str("template")
    if template is not None:
        selected = [{
            key: row.get(key)
            for key in sorted(fields or [])
        } for row in rows]
        return text_out(render_template(template, selected))
    return await typed_out(
        rows, fl,
        _human(kind, rows, values, kind == "issues"
               and _boolean(fl, "include_prs")), FIELDS[kind])


SHAPES = {
    'Repository': [['createdAt', 'created_at', 'time.Time'],
                   ['defaultBranch', 'default_branch', 'string'],
                   ['description', 'description', 'string'],
                   ['forksCount', 'forks_count', 'int'],
                   ['fullName', 'full_name', 'string'],
                   ['hasDownloads', 'has_downloads', 'bool'],
                   ['hasIssues', 'has_issues', 'bool'],
                   ['hasPages', 'has_pages', 'bool'],
                   ['hasProjects', 'has_projects', 'bool'],
                   ['hasWiki', 'has_wiki', 'bool'],
                   ['homepage', 'homepage', 'string'],
                   ['id', 'node_id', 'string'],
                   ['isArchived', 'archived', 'bool'],
                   ['isDisabled', 'disabled', 'bool'],
                   ['isFork', 'fork', 'bool'],
                   ['isPrivate', 'private', 'bool'],
                   ['language', 'language', 'string'],
                   ['license', 'license', 'License'],
                   ['masterBranch', 'master_branch', 'string'],
                   ['name', 'name', 'string'],
                   ['openIssuesCount', 'open_issues_count', 'int'],
                   ['owner', 'owner', 'User'],
                   ['pushedAt', 'pushed_at', 'time.Time'],
                   ['size', 'size', 'int'],
                   ['stargazersCount', 'stargazers_count', 'int'],
                   ['url', 'html_url', 'string'],
                   ['updatedAt', 'updated_at', 'time.Time'],
                   ['visibility', 'visibility', 'string'],
                   ['watchersCount', 'watchers_count', 'int']],
    'User': [['gravatarID', 'gravatar_id', 'string'],
             ['id', 'node_id', 'string'], ['login', 'login', 'string'],
             ['siteAdmin', 'site_admin', 'bool'], ['type', 'type', 'string'],
             ['url', 'html_url', 'string']],
    'CommitInfo': [['author', 'author', 'CommitUser'],
                   ['commentCount', 'comment_count', 'int'],
                   ['committer', 'committer', 'CommitUser'],
                   ['message', 'message', 'string'], ['tree', 'tree', 'Tree']],
    'CommitUser': [['date', 'date', 'time.Time'], ['email', 'email', 'string'],
                   ['name', 'name', 'string']],
    'Tree': [['sha', 'sha', 'string']],
    'Parent': [['sha', 'sha', 'string'], ['url', 'html_url', 'string']],
    'License': [['key', 'key', 'string'], ['name', 'name', 'string'],
                ['url', 'url', 'string']],
    'Label': [['color', 'color', 'string'],
              ['description', 'description', 'string'],
              ['id', 'node_id', 'string'], ['name', 'name', 'string']],
    'Issue': [['assignees', 'assignees', '[]User'], ['author', 'user', 'User'],
              ['authorAssociation', 'author_association', 'string'],
              ['body', 'body', 'string'],
              ['closedAt', 'closed_at', 'time.Time'],
              ['commentsCount', 'comments', 'int'],
              ['createdAt', 'created_at', 'time.Time'],
              ['id', 'node_id', 'string'], ['labels', 'labels', '[]Label'],
              ['isDraft', 'draft', '*bool'], ['isLocked', 'locked', 'bool'],
              ['number', 'number', 'int'],
              ['pullRequest', 'pull_request', 'PullRequest'],
              ['repositoryURL', 'repository_url', 'string'],
              ['stateInternal', 'state', 'string'],
              ['stateReason', 'state_reason', 'string'],
              ['title', 'title', 'string'], ['url', 'html_url', 'string'],
              ['updatedAt', 'updated_at', 'time.Time']],
    'Code': [['name', 'name', 'string'], ['path', 'path', 'string'],
             ['repository', 'repository', 'Repository'],
             ['sha', 'sha', 'string'],
             ['textMatches', 'text_matches', '[]TextMatch'],
             ['url', 'html_url', 'string']],
    'Commit': [['author', 'author', 'User'],
               ['committer', 'committer', 'User'], ['id', 'node_id', 'string'],
               ['info', 'commit', 'CommitInfo'],
               ['parents', 'parents', '[]Parent'],
               ['repo', 'repository', 'Repository'], ['sha', 'sha', 'string'],
               ['url', 'html_url', 'string']]
}


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _shape(kind: str, value: Any) -> Any:
    if kind.startswith("*"):
        return None if value is None else _shape(kind[1:], value)
    if kind.startswith("[]"):
        return [_shape(kind[2:], item)
                for item in value] if isinstance(value, list) else None
    if kind == "time.Time":
        return value or "0001-01-01T00:00:00Z"
    if kind == "string":
        return value or ""
    if kind == "bool":
        return bool(value)
    if kind == "int":
        return value or 0
    row = _record(value)
    return {
        name: _shape(typ, row.get(key))
        for name, key, typ in SHAPES.get(kind, [])
    }


def _user(value: Any) -> dict[str, Any]:
    row = _record(value)
    bot = not row.get("node_id")
    return {
        "id": row.get("node_id") or "",
        "login": ("app/" if bot else "") + (row.get("login") or ""),
        "type": row.get("type") or "",
        "url": row.get("html_url") or "",
        "is_bot": bot
    }


def _export(kind: str, value: Any) -> dict[str, Any]:
    raw = _record(value)
    row: dict[str, Any] = _shape({
        "repos": "Repository",
        "issues": "Issue",
        "prs": "Issue",
        "code": "Code",
        "commits": "Commit"
    }[kind], raw)
    if kind == "repos":
        row["owner"] = _user(raw.get("owner"))
    elif kind in ("issues", "prs"):
        row["author"] = _user(raw.get("user"))
        row["assignees"] = [
            _user(user) for user in raw.get("assignees", []) or []
        ]
        row["labels"] = row.get("labels") or []
        pull = _record(raw.get("pull_request"))
        row["isPullRequest"] = bool(pull.get("html_url"))
        row["state"] = "merged" if pull.get("merged_at") else raw.get(
            "state", "")
        parts = str(raw.get("repository_url", "")).rstrip("/").split("/")
        row["repository"] = {
            "name": parts[-1],
            "nameWithOwner": "/".join(parts[-2:])
        }
    elif kind == "code":
        repo = _record(raw.get("repository"))
        row["repository"] = {
            "id": repo.get("node_id") or "",
            "nameWithOwner": repo.get("full_name") or "",
            "url": repo.get("html_url") or "",
            "isPrivate": bool(repo.get("private")),
            "isFork": bool(repo.get("fork"))
        }
        row["textMatches"] = [{
            "fragment": m.get("fragment", ""),
            "matches": m.get("matches"),
            "type": m.get("object_type", ""),
            "property": m.get("property", "")
        } for m in raw.get("text_matches", []) or []]
    elif kind == "commits":
        row["author"] = _user(raw.get("author"))
        row["committer"] = _user(raw.get("committer"))
        info = _record(raw.get("commit"))
        row["commit"] = {
            "author": _shape("CommitUser", info.get("author")),
            "committer": _shape("CommitUser", info.get("committer")),
            "comment_count": info.get("comment_count") or 0,
            "message": info.get("message") or "",
            "tree": _shape("Tree", info.get("tree"))
        }
        row["parents"] = row.get("parents") or []
        repo = _export("repos", raw.get("repository"))
        row["repository"] = {
            key: repo[key]
            for key in ("description", "fullName", "name", "id", "isFork",
                        "isPrivate", "owner", "url")
        }
    return row


def _human(kind: str, rows: list[dict[str, Any]], values: list[Any],
           both: bool) -> str:
    lines = []
    for row, value in zip(rows, values):
        raw = _record(value)
        if kind in ("issues", "prs"):
            cells = (["pr" if row["isPullRequest"] else "issue"]
                     if both else []) + [
                         row["repository"]["nameWithOwner"],
                         str(row["number"]), row["state"], " ".join(
                             row["title"].split()), ", ".join(
                                 label["name"]
                                 for label in row["labels"]), row["updatedAt"]
                     ]
        elif kind == "repos":
            tags = [
                row["visibility"]
                or ("private" if row["isPrivate"] else "public")
            ]
            tags += [
                label for key, label in (("isFork", "fork"), ("isArchived",
                                                              "archived"))
                if row[key]
            ]
            cells = [
                row["fullName"], " ".join(row["description"].split()),
                ", ".join(tags), row["updatedAt"]
            ]
        elif kind == "commits":
            cells = [
                row["repository"]["fullName"], row["sha"],
                " ".join(row["commit"]["message"].split()),
                _record(raw.get("author")).get("login", ""),
                row["commit"]["author"]["date"]
            ]
        else:
            for match in row["textMatches"]:
                offset = 0
                for line in match["fragment"].split("\n"):
                    end = offset + len(line.encode())
                    if any(offset <= m.get("indices", [-1])[0] < end
                           for m in match["matches"] or []):
                        lines.append(f'{row["repository"]["nameWithOwner"]}:'
                                     f'{row["path"]}: {line.strip()}\n')
                    offset = end + 1
            continue
        lines.append("\t".join(cells) + "\n")
    return "".join(lines)
