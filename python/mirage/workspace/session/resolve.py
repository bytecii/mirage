# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from collections.abc import Iterable, Mapping

from mirage.policy.errors import PolicyError
from mirage.policy.match.pattern import intersect_patterns
from mirage.policy.types import (AdmissionRules, CommandRule, HideReason,
                                 ProfileScript)
from mirage.types import (HiddenPaths, HiddenVars, MountMode, ShowEntry,
                          ShownPaths, weaker_mode)
from mirage.utils.hidden import (anchor_depth, classify_paths, classify_shows,
                                 classify_vars, hide_depth, is_glob)
from mirage.workspace.session.constants import DEFAULT_PROFILE
from mirage.workspace.session.session import Session, vars_from_env
from mirage.workspace.session.shell_dirs import set_cwd
from mirage.workspace.session.validate import check_rules

from mirage.policy.profile import (  # isort: skip
    CommandsBlock, CompiledProfile, MountCommandsBlock, PathsBlock,
    ProfileMount, SessionProfile, VarsBlock)


def resolve_profile(
    profiles: Mapping[str, SessionProfile],
    profile: str | SessionProfile | None,
) -> SessionProfile | None:
    """The profile a session is created from.

    A name is looked up as written; a profile object is itself; None
    picks ``profiles.default`` when the workspace defines one and
    leaves the session unrestricted otherwise. There is no inheritance
    chain: a profile is the whole document, so nothing is assembled from
    somewhere else before it is read.

    Args:
        profiles (Mapping[str, SessionProfile]): the workspace's named
            profiles.
        profile (str | SessionProfile | None): what ``create_session``
            was given.

    Raises:
        PolicyError: the name is not a profile the workspace defines.
    """
    if profile is None:
        return profiles.get(DEFAULT_PROFILE)
    if not isinstance(profile, str):
        return profile
    if profile not in profiles:
        raise PolicyError(f"unknown profile {profile!r}")
    return profiles[profile]


def _union_hide(a: PathsBlock | VarsBlock | None,
                b: PathsBlock | VarsBlock | None) -> tuple[str, ...]:
    """Every entry of both blocks, first spelling wins, order kept.

    Args:
        a (PathsBlock | VarsBlock | None): the profile's block.
        b (PathsBlock | VarsBlock | None): the inline block.
    """
    out: list[str] = []
    for block in (a, b):
        for entry in (block.hide if block is not None else ()):
            if entry not in out:
                out.append(entry)
    return tuple(out)


def refuse_allow(inline: CommandsBlock | None) -> None:
    """Refuse an allow list in an inline document.

    The refusal belongs to *where the document was written*, not to
    whether a profile happened to resolve, so both paths into
    ``with_inline`` run it: a workspace with no default profile must not
    quietly accept a list a workspace with one refuses.

    Args:
        inline (CommandsBlock | None): what ``create_session`` added.

    Raises:
        PolicyError: the inline document states an allow list.
    """
    if inline is not None and inline.allow is not None:
        raise PolicyError("inline permissions may add ask and deny rules, "
                          "not an allow list")


def refuse_show(inline: SessionProfile) -> None:
    """Refuse a show entry in an inline document.

    An inline document may only restrict: it adds ask and deny rules
    and hides. A show re-opens a subtree or states a mode, which is the
    profile's to say; same rule as :func:`refuse_allow`, and it runs on
    both paths into ``with_inline`` for the same reason.

    Args:
        inline (SessionProfile): what ``create_session`` added.

    Raises:
        PolicyError: the inline document states a show entry.
    """
    blocks = [inline.paths]
    blocks.extend(entry.paths for entry in (inline.mounts or {}).values())
    if any(block is not None and block.show for block in blocks):
        raise PolicyError("inline permissions may add ask and deny rules "
                          "and hides, not show entries")


def _add_commands(base: CommandsBlock | None,
                  inline: CommandsBlock | None) -> CommandsBlock | None:
    """The profile's commands block with the inline document's rules added.

    An inline document may only restrict, so it carries ask and deny
    rules and never an allow list: a list there would install a command
    the profile does not have, which is the one thing a per-call document
    must not do.

    Args:
        base (CommandsBlock | None): the profile's block.
        inline (CommandsBlock | None): what ``create_session`` added.

    Raises:
        PolicyError: the inline document states an allow list.
    """
    if inline is None:
        return base
    refuse_allow(inline)
    if base is None:
        return inline
    return CommandsBlock(allow=base.allow,
                         ask=base.ask + inline.ask,
                         deny=base.deny + inline.deny)


def _add_mount(base: ProfileMount | None,
               inline: ProfileMount | None) -> ProfileMount:
    """One mount's entry with the inline document's added: the weaker
    mode, both rule lists, both hide lists.

    Args:
        base (ProfileMount | None): the profile's entry, None when it
            names no settings for this mount.
        inline (ProfileMount | None): the inline entry.
    """
    if base is None:
        return inline if inline is not None else ProfileMount()
    if inline is None:
        return base
    mode = base.mode
    if inline.mode is not None:
        mode = (inline.mode if mode is None else weaker_mode(
            mode, inline.mode))
    ask = _rules_of(base.commands, "ask") + _rules_of(inline.commands, "ask")
    deny = _rules_of(base.commands, "deny") + _rules_of(
        inline.commands, "deny")
    hide = _union_hide(base.paths, inline.paths)
    show = base.paths.show if base.paths is not None else ()
    reasons = _merge_reasons(base.paths, inline.paths)
    return ProfileMount(
        mode=mode,
        commands=(MountCommandsBlock(ask=ask, deny=deny) if
                  (ask or deny) else None),
        paths=(PathsBlock(hide=hide, show=show, reasons=reasons) if
               (hide or show or reasons) else None))


def _merge_reasons(a: PathsBlock | None,
                   b: PathsBlock | None) -> tuple[HideReason, ...]:
    """Both blocks' reason groups, the profile's first.

    Args:
        a (PathsBlock | None): the profile's block.
        b (PathsBlock | None): the inline block.
    """
    out: list[HideReason] = []
    for block in (a, b):
        if block is not None:
            out.extend(block.reasons)
    return tuple(out)


def _rules_of(block: MountCommandsBlock | None,
              verb: str) -> tuple[CommandRule, ...]:
    """One verb's rules in a mount entry's commands block, empty when
    unstated.

    Args:
        block (MountCommandsBlock | None): the entry's block.
        verb (str): ``ask`` or ``deny``.
    """
    if block is None:
        return ()
    return block.ask if verb == "ask" else block.deny


def with_inline(base: SessionProfile | None,
                inline: SessionProfile | None) -> SessionProfile | None:
    """A profile with the inline document of one ``create_session`` added.

    The one rule about combining two documents: an inline document may
    add ask and deny rules and hides, never an allow list and never a
    script, and that holds even when there is no profile to add to.
    Modes take the weaker of the two, ``cwd`` and ``env`` are the
    inline document's when it states them (they are session presets,
    not permissions). Either side None returns the other unchanged; the
    profile's policy survives the merge, since the inline document can
    only add rules beside it.

    Args:
        base (SessionProfile | None): the resolved profile.
        inline (SessionProfile | None): what ``create_session`` added.

    Raises:
        PolicyError: the inline document states an allow list or a
            script.
    """
    if inline is None:
        return base
    refuse_allow(inline.commands)
    refuse_show(inline)
    if inline.policy is not None:
        raise PolicyError("inline permissions may add ask and deny rules, "
                          "not a policy; state one on the profile")
    if base is None:
        return inline
    hide_paths = _union_hide(base.paths, inline.paths)
    hide_vars = _union_hide(base.vars, inline.vars)
    env = None
    if base.env is not None or inline.env is not None:
        env = {**(base.env or {}), **(inline.env or {})}
    mounts: dict[str, ProfileMount] | None = None
    if base.mounts is not None or inline.mounts is not None:
        prefixes = [*(base.mounts or {})]
        prefixes.extend(p for p in (inline.mounts or {}) if p not in prefixes)
        mounts = {
            prefix:
            _add_mount((base.mounts or {}).get(prefix), (inline.mounts
                                                         or {}).get(prefix))
            for prefix in prefixes
        }
    return SessionProfile(
        cwd=inline.cwd if inline.cwd is not None else base.cwd,
        env=env,
        mounts=mounts,
        paths=(PathsBlock(hide=hide_paths,
                          show=base.paths.show if base.paths is not None else
                          (),
                          reasons=_merge_reasons(base.paths, inline.paths)) if
               (base.paths is not None or inline.paths is not None) else None),
        vars=(VarsBlock(hide=hide_vars) if
              (base.vars is not None or inline.vars is not None) else None),
        commands=_add_commands(base.commands, inline.commands),
        policy=base.policy,
    )


def _root_of(prefix: str) -> str:
    """One spelling for a mount prefix: leading slash, no trailing one.

    Args:
        prefix (str): the prefix as the document spells it.
    """
    return "/" + prefix.strip("/")


def _anchored(entries: tuple[str, ...], root: str) -> tuple[str, ...]:
    """A mount section's path entries, anchored to the mount they are
    written under.

    An absolute entry already names something inside the root
    (``_under_mount`` refuses one that does not) and is left as written.
    A name pattern (``*.pem``, no slash) anchors nothing, and both
    places a mount section's entries are read from have lost the
    section by then: the session's hidden set is one list for every
    mount, and the op door matches a rule's paths without consulting
    ``rule.mount``. Left raw, ``mounts./repo.paths.hide: ["*.pem"]``
    hid ``/other/key.pem`` too, and a path-only deny under ``/repo``
    refused a read of it. The dialect's ``*`` crosses ``/``, so
    ``/repo/*.pem`` is every ``.pem`` at any depth below ``/repo`` and
    nothing outside it; anchoring also gives the entry the mount's own
    anchor depth, which is what it was always worth.

    Args:
        entries (tuple[str, ...]): the entries as written.
        root (str): the mount root, leading slash, no trailing one.
    """
    return tuple(e if e.startswith("/") else f"{root.rstrip('/')}/{e}"
                 for e in entries)


def _scoped_rules(rules: tuple[CommandRule, ...],
                  root: str) -> tuple[CommandRule, ...]:
    """A mount entry's rules, stamped with the mount they belong to and
    anchored to it.

    The stamp is what makes the rule apply to a line that *works
    inside* the mount, by cwd or by operand, which a path-scoped rule
    cannot express. The anchor is for the entries the stamp cannot
    reach: the op door reads a rule's paths alone (:func:`_anchored`).

    Args:
        rules (tuple[CommandRule, ...]): the rules as written.
        root (str): the mount prefix, leading slash, no trailing one.
    """
    return tuple(
        CommandRule(reason=rule.reason,
                    commands=rule.commands,
                    paths=_anchored(rule.paths, root),
                    mount=root) for rule in rules)


def compile_commands(profile: SessionProfile) -> AdmissionRules | None:
    """A profile's admission rules: its own, plus every mount entry's,
    in one list; None when the profile states none.

    Mount rules come first so the entry closest to the data speaks
    first when several rules match at the same anchor depth and only
    the message differs.

    Args:
        profile (SessionProfile): the resolved profile.
    """
    ask: list[CommandRule] = []
    deny: list[CommandRule] = []
    for prefix, entry in (profile.mounts or {}).items():
        root = _root_of(prefix)
        ask.extend(_scoped_rules(_rules_of(entry.commands, "ask"), root))
        deny.extend(_scoped_rules(_rules_of(entry.commands, "deny"), root))
    block = profile.commands
    allow = block.allow if block is not None else None
    if block is not None:
        ask.extend(block.ask)
        deny.extend(block.deny)
    if allow is None and not ask and not deny:
        return None
    return AdmissionRules(allow=allow, ask=tuple(ask), deny=tuple(deny))


def _hidden(profile: SessionProfile) -> HiddenPaths | None:
    """Every path the profile hides: its own entries, and each mount
    entry's anchored to the mount it was written under, since the set
    is one list for the whole session and nothing in it remembers which
    section an entry came from (:func:`_anchored`).

    Args:
        profile (SessionProfile): the resolved profile.
    """
    entries: list[str] = []
    if profile.paths is not None:
        entries.extend(profile.paths.hide)
    for prefix, entry in (profile.mounts or {}).items():
        if entry.paths is not None:
            entries.extend(_anchored(entry.paths.hide, _root_of(prefix)))
    return classify_paths(entries)


def _shown(profile: SessionProfile) -> ShownPaths | None:
    """Every show entry the profile states: its own and each mount
    section's, one list, since a show entry is absolute wherever it is
    written and the compiled axis has no sections.

    Args:
        profile (SessionProfile): the resolved profile.
    """
    entries: list[ShowEntry] = []
    if profile.paths is not None:
        entries.extend(profile.paths.show)
    for entry in (profile.mounts or {}).values():
        if entry.paths is not None:
            entries.extend(entry.paths.show)
    return classify_shows(entries)


def _hide_reasons(profile: SessionProfile) -> tuple[HideReason, ...]:
    """The operator's reasons for grouped hides, a mount section's
    anchored to its mount exactly like the hide entries they describe,
    so the side table names what the compiled spec matches.

    Args:
        profile (SessionProfile): the resolved profile.
    """
    groups: list[HideReason] = []
    if profile.paths is not None:
        groups.extend(profile.paths.reasons)
    for prefix, entry in (profile.mounts or {}).items():
        if entry.paths is not None:
            root = _root_of(prefix)
            groups.extend(
                HideReason(patterns=_anchored(g.patterns, root),
                           reason=g.reason) for g in entry.paths.reasons)
    return tuple(groups)


def _modes(profile: SessionProfile) -> dict[str, MountMode] | None:
    """The mode each mount section states, None when none does.

    A mount the profile does not name is absent from the map and keeps
    the mode it declares in the workspace's ``mounts:``; the map only
    narrows, it never grants.

    Args:
        profile (SessionProfile): the resolved profile.
    """
    modes = {
        prefix: entry.mode
        for prefix, entry in (profile.mounts or {}).items()
        if entry.mode is not None
    }
    return modes or None


def compile_script(effective: SessionProfile,
                   name: str) -> ProfileScript | None:
    """The profile's per-command script, compiled onto the session.

    Args:
        effective (SessionProfile): the resolved profile.
        name (str): the profile's name, empty for a document passed
            without one; what the script reads as ``ctx["profile"]``.

    Raises:
        PolicyError: the policy is still a path, which means it reached
            the workspace without passing the config door that loads
            one.
    """
    policy = effective.policy
    if policy is None:
        return None
    if isinstance(policy.script, str):
        raise PolicyError(
            f"profile {name!r} names a policy by path "
            f"({policy.script!r}); only the config door loads one, pass "
            f"ScriptSource in code")
    return ProfileScript(profile=name,
                         script=policy.script,
                         runtime=policy.runtime)


def compile_profile(effective: SessionProfile | None,
                    name: str = "") -> CompiledProfile:
    """The session fields a profile compiles to.

    Args:
        effective (SessionProfile | None): the resolved profile with any
            inline document already added; None is an unrestricted
            session.
        name (str): the profile's name, empty for a document passed
            without one; carried onto its script for ``ctx["profile"]``,
            for refusals to print, and onto the session as the group an
            owner-rendering command shows.
    """
    if effective is None:
        return CompiledProfile(mount_modes=None,
                               hidden_paths=None,
                               hidden_vars=None,
                               env=None,
                               cwd=None,
                               commands=None,
                               profile=name or None)
    commands = compile_commands(effective)
    check_rules(commands)
    return CompiledProfile(
        mount_modes=_modes(effective),
        hidden_paths=_hidden(effective),
        hidden_vars=classify_vars(
            effective.vars.hide if effective.vars is not None else ()),
        env=dict(effective.env) if effective.env is not None else None,
        cwd=effective.cwd,
        commands=commands,
        script=compile_script(effective, name),
        shown_paths=_shown(effective),
        hide_reasons=_hide_reasons(effective),
        profile=name or None,
    )


def narrow(session: Session, compiled: CompiledProfile) -> None:
    """Stamp a compiled profile's narrowing onto a session.

    The fields no shell line can edit: the per-mount modes, hidden
    paths, show entries, hidden variables, hide reasons, the admission
    rules, the profile's policy, the profile's name. Applied at creation
    and again whenever a stored record could carry a stale copy (the
    default session after hydration), so the document, not the store,
    is what an agent runs under.

    Args:
        session (Session): the session to narrow.
        compiled (CompiledProfile): the effective profile.
    """
    session.mount_modes = (dict(compiled.mount_modes)
                           if compiled.mount_modes is not None else None)
    session.hidden_paths = compiled.hidden_paths
    session.shown_paths = compiled.shown_paths
    session.hidden_vars = compiled.hidden_vars
    session.hide_reasons = compiled.hide_reasons
    session.commands = compiled.commands
    session.script = compiled.script
    session.profile = compiled.profile


def narrowing_of(session: Session) -> CompiledProfile:
    """A session's narrowing read back as a compiled profile.

    What :func:`narrow` stamps, in the shape it stamps from, so a
    caller that narrows a live session speculatively can put the
    session back with ``narrow(session, saved)``. A restore does
    exactly that: it joins each table's profile onto the session
    before the ``pre_session`` gate runs, and a refusal there has to
    leave the workspace as it was. The scratch halves of a profile
    (``env``, ``cwd``) are not narrowing and are not read.

    Args:
        session (Session): the session to read.
    """
    return CompiledProfile(mount_modes=dict(session.mount_modes)
                           if session.mount_modes is not None else None,
                           hidden_paths=session.hidden_paths,
                           hidden_vars=session.hidden_vars,
                           env=None,
                           cwd=None,
                           commands=session.commands,
                           script=session.script,
                           shown_paths=session.shown_paths,
                           hide_reasons=session.hide_reasons,
                           profile=session.profile)


def narrow_profile(session: Session, compiled: CompiledProfile) -> None:
    """Join a profile onto a session that is already running, never wider.

    :func:`narrow` stamps a profile onto a session the host creates or
    resets; this adds one to a live session, which is what a restore
    does to the session a stored table lands on. A table names the
    profile its source session ran under, and the target's document of
    that name is what must govern the restored session — including its
    policy program, which the table cannot carry and
    :func:`narrow_restored` deliberately never takes off it. The join
    is :func:`narrow_restored`'s, for the same reason: restrictions
    union, grants intersect, so a session that has accumulated
    restrictions of its own keeps every one of them.

    The program is the profile's when the session runs none, and the
    session's when it does: a checkout must not swap out a program the
    host installed with ``set_session_profile``, which stays the host's
    reset. The name travels with the program, so a session never
    reports a group whose script it is not running.

    Args:
        session (Session): the live session.
        compiled (CompiledProfile): the target's profile of the name
            the table carries.
    """
    modes = _merge_modes(session.mount_modes, compiled.mount_modes)
    hidden = _merge_hidden_paths(session.hidden_paths, compiled.hidden_paths)
    shown = _merge_shown(session.shown_paths, compiled.shown_paths,
                         session.mount_modes, compiled.mount_modes,
                         session.hidden_paths, compiled.hidden_paths)
    session.hidden_vars = _merge_hidden_vars(session.hidden_vars,
                                             compiled.hidden_vars)
    session.hide_reasons = _merge_groups(session.hide_reasons,
                                         compiled.hide_reasons)
    session.commands = _merge_commands(session.commands, compiled.commands)
    if session.script is None:
        session.script = compiled.script
        session.profile = compiled.profile
    session.mount_modes = modes
    session.hidden_paths = hidden
    session.shown_paths = shown


def apply_profile(session: Session, compiled: CompiledProfile) -> None:
    """Narrow a fresh session and seed its scratch state from the profile.

    A profile's env is a *process* environment, the same shape
    ``ws.env = {...}`` speaks, so every name in it is exported: seeding
    them plain left ``$TOKEN`` expanding while every command, CLI and
    guest runtime in the profiled session saw nothing, since all three
    read ``env_snapshot`` and that is the exported set. The cwd is where
    the session starts; both are the agent's to change afterwards,
    which is why hydration keeps the stored ones and re-stamps only
    :func:`narrow`.

    Args:
        session (Session): the session just created.
        compiled (CompiledProfile): the effective profile.
    """
    narrow(session, compiled)
    if compiled.env:
        session.vars.update(vars_from_env(compiled.env))
    if compiled.cwd is not None:
        set_cwd(session, compiled.cwd)


def _dedupe(entries: Iterable[str]) -> tuple[str, ...]:
    """The entries in order, each spelling once.

    Args:
        entries (Iterable[str]): document entries, both sides' in turn.
    """
    out: list[str] = []
    for entry in entries:
        if entry not in out:
            out.append(entry)
    return tuple(out)


def _merge_modes(
        base: dict[str, MountMode] | None,
        table: dict[str, MountMode] | None) -> dict[str, MountMode] | None:
    """The weaker mode per prefix over both maps, prefixes normalized;
    the base map itself when the table narrows nothing.

    Args:
        base (dict[str, MountMode] | None): the session's caps.
        table (dict[str, MountMode] | None): the stored table's caps.
    """
    if table is None:
        return base
    merged = {_root_of(p): m for p, m in (base or {}).items()}
    for prefix, mode in table.items():
        root = _root_of(prefix)
        have = merged.get(root)
        merged[root] = mode if have is None else weaker_mode(have, mode)
    return base if base is not None and merged == base else merged


def _merge_hidden_paths(base: HiddenPaths | None,
                        table: HiddenPaths | None) -> HiddenPaths | None:
    """Both hide sets in one, the session's entries first; the
    session's own object when the table hides nothing new.

    Args:
        base (HiddenPaths | None): the session's spec.
        table (HiddenPaths | None): the stored table's spec.
    """
    if table is None:
        return base
    if base is None:
        return table
    merged = classify_paths(
        _dedupe((*base.paths, *base.patterns, *table.paths, *table.patterns)))
    return base if merged == base else merged


def _merge_hidden_vars(base: HiddenVars | None,
                       table: HiddenVars | None) -> HiddenVars | None:
    """Both hidden-variable sets in one, the session's first; the
    session's own object when the table hides nothing new.

    Args:
        base (HiddenVars | None): the session's spec.
        table (HiddenVars | None): the stored table's spec.
    """
    if table is None:
        return base
    if base is None:
        return table
    merged = classify_vars(
        _dedupe((*base.names, *base.patterns, *table.names, *table.patterns)))
    return base if merged == base else merged


def _merge_groups(base: tuple[HideReason, ...],
                  table: tuple[HideReason, ...]) -> tuple[HideReason, ...]:
    """The session's reason groups, then the table's it lacks.

    Args:
        base (tuple[HideReason, ...]): the session's groups.
        table (tuple[HideReason, ...]): the stored table's groups.
    """
    out = list(base)
    out.extend(group for group in table if group not in out)
    return base if len(out) == len(base) else tuple(out)


def _append_rules(base: tuple[CommandRule, ...],
                  table: tuple[CommandRule, ...]) -> tuple[CommandRule, ...]:
    """The session's rules, then the table's it lacks.

    Args:
        base (tuple[CommandRule, ...]): the session's rules of one verb.
        table (tuple[CommandRule, ...]): the stored table's.
    """
    out = list(base)
    out.extend(rule for rule in table if rule not in out)
    return base if len(out) == len(base) else tuple(out)


def _merge_allow(base: tuple[str, ...] | None,
                 table: tuple[str, ...] | None) -> tuple[str, ...] | None:
    """The allow list both sides grant.

    One side stating a list installs only what it lists, so that list
    stands when the other states none; two lists intersect pattern by
    pattern (``intersect_patterns``), which can only remove. The
    session's own list stands when the table spells the same set, so a
    table that adds nothing changes nothing.

    Args:
        base (tuple[str, ...] | None): the session's list.
        table (tuple[str, ...] | None): the stored table's list.
    """
    if table is None:
        return base
    if base is None or set(base) == set(table):
        return table if base is None else base
    return intersect_patterns(base, table)


def _merge_commands(base: AdmissionRules | None,
                    table: AdmissionRules | None) -> AdmissionRules | None:
    """Both rule sets as one: ask and deny rules union, the allow list
    intersects; the session's own object when the table adds nothing.

    Args:
        base (AdmissionRules | None): the session's rules.
        table (AdmissionRules | None): the stored table's rules.
    """
    if table is None:
        return base
    if base is None:
        return table
    merged = AdmissionRules(allow=_merge_allow(base.allow, table.allow),
                            ask=_append_rules(base.ask, table.ask),
                            deny=_append_rules(base.deny, table.deny))
    return base if merged == base else merged


def _cap_of(modes: dict[str, MountMode] | None, head: str) -> MountMode | None:
    """The per-mount cap in force at a path: the mode of the longest
    prefix covering it, None when none does.

    Args:
        modes (dict[str, MountMode] | None): one side's caps.
        head (str): the place a show entry anchors to.
    """
    best: tuple[int, MountMode] | None = None
    for prefix, mode in (modes or {}).items():
        root = _root_of(prefix)
        if root == "/" or head == root or head.startswith(root + "/"):
            depth = anchor_depth(root)
            if best is None or depth > best[0]:
                best = (depth, mode)
    return None if best is None else best[1]


def _capped(mode: MountMode, caps: dict[str, MountMode] | None,
            head: str) -> MountMode:
    """A show mode one side states, held under the other side's cap at
    that anchor: a show scores deeper than the cap and would otherwise
    lift what the other side capped.

    Args:
        mode (MountMode): the stated mode.
        caps (dict[str, MountMode] | None): the other side's caps.
        head (str): the show's anchor.
    """
    cap = _cap_of(caps, head)
    return mode if cap is None else weaker_mode(mode, cap)


def _hides_show(hidden: HiddenPaths | None, path: str) -> bool:
    """Whether one side's hides cover a show entry the other side states.

    The question a one-sided show turns on, and it is asked of the
    *other* side's hides, never of the merged set: a show exists to
    re-open what a hide covers, so the side that states the show has a
    hide over it by construction, and testing the union would drop
    every show against its own hide. An exact entry is tested against
    those hides; a pattern re-opens by name and no comparison proves
    which names a hide leaves open, so it counts as covered wherever
    the other side hides at all.

    Args:
        hidden (HiddenPaths | None): the other side's hide set, None
            when that side hides nothing.
        path (str): the show entry's path.
    """
    if hidden is None or (not hidden.paths and not hidden.patterns):
        return False
    return is_glob(path) or hide_depth(hidden, path) is not None


def _merge_show(mine: ShowEntry, other: ShowEntry | None,
                my_caps: dict[str, MountMode] | None,
                other_caps: dict[str, MountMode] | None,
                other_hidden: HiddenPaths | None) -> ShowEntry | None:
    """One show entry as both sides allow it, or None to drop it.

    A show does two things, and each side has to have said it. It
    re-opens what a hide covers, so an entry only one side states
    survives exactly where the other side hides nothing over it
    (:func:`_hides_show`) — that side left the path open, so both
    allow it. It states the mode below its anchor, and a show scores
    deeper than a per-mount cap, so a mode only one side states is
    held under the other side's cap there; two stated modes take the
    weaker; two list-form entries stay list-form, since the merged
    caps already hold the weaker mode below them. The entry itself is
    returned when nothing changed, so an identical table leaves the
    session's objects in place.

    Args:
        mine (ShowEntry): the entry on the side being walked.
        other (ShowEntry | None): the other side's entry at the same
            path, None when it states none.
        my_caps (dict[str, MountMode] | None): this side's caps.
        other_caps (dict[str, MountMode] | None): the other side's.
        other_hidden (HiddenPaths | None): the other side's hide set.
    """
    if other is None:
        if _hides_show(other_hidden, mine.path):
            return None
        if mine.mode is None:
            return mine
        mode = _capped(mine.mode, other_caps, mine.path)
    elif mine.mode is not None and other.mode is not None:
        mode = weaker_mode(mine.mode, other.mode)
    elif mine.mode is not None:
        mode = _capped(mine.mode, other_caps, mine.path)
    elif other.mode is not None:
        mode = _capped(other.mode, my_caps, mine.path)
    else:
        return mine
    return mine if mode == mine.mode else ShowEntry(path=mine.path, mode=mode)


def _merge_shown(base: ShownPaths | None, table: ShownPaths | None,
                 base_caps: dict[str, MountMode] | None,
                 table_caps: dict[str, MountMode] | None,
                 base_hidden: HiddenPaths | None,
                 table_hidden: HiddenPaths | None) -> ShownPaths | None:
    """Both sides' show entries as both allow them (:func:`_merge_show`),
    the session's first; the session's own object when nothing changed.

    Each side is walked against the *other* side's hides, which is why
    both sets are passed rather than their union.

    Args:
        base (ShownPaths | None): the session's entries.
        table (ShownPaths | None): the stored table's entries.
        base_caps (dict[str, MountMode] | None): the session's caps.
        table_caps (dict[str, MountMode] | None): the table's caps.
        base_hidden (HiddenPaths | None): the session's hide set.
        table_hidden (HiddenPaths | None): the table's hide set.
    """
    if base is None and table is None:
        return None
    base_entries = base.entries if base is not None else ()
    table_entries = table.entries if table is not None else ()
    by_table = {entry.path: entry for entry in table_entries}
    by_base = {entry.path: entry for entry in base_entries}
    out: list[ShowEntry] = []
    for entry in base_entries:
        merged = _merge_show(entry, by_table.get(entry.path), base_caps,
                             table_caps, table_hidden)
        if merged is not None:
            out.append(merged)
    for entry in table_entries:
        if entry.path in by_base:
            continue
        merged = _merge_show(entry, None, table_caps, base_caps, base_hidden)
        if merged is not None:
            out.append(merged)
    if base is not None and tuple(out) == base.entries:
        return base
    return classify_shows(out)


def narrow_restored(session: Session, table: Session) -> None:
    """Land a stored session table on a session, never wider than either.

    The restore's counterpart of :func:`narrow`. A snapshot carries a
    session's narrowing as it stood in the source deployment; the
    session it lands on already runs under the target's document (the
    profile of the same name, or the live session's on a checkout). One
    rule joins the two: restrictions union, grants intersect, the
    program is the target's. Caps take the weaker mode per prefix,
    hides and hidden variables union, hide reasons and ask and deny
    rules append what the session lacks, the allow list is what both
    grant, a show survives only as both sides allow it
    (:func:`_merge_show`), and ``script`` and ``profile`` stay the
    session's, since a policy program is deployment code and the gate
    judged the table under the target's. Every field keeps the
    session's own object when the table adds nothing, so a table taken
    from the same document is the identity, and running this twice is
    running it once, which a checkout that lands live tables back on
    themselves relies on.

    Two consequences worth stating. On a running workspace a checkout
    can only add restrictions to a live session, never lift one: a hide
    from one version survives checking out another, and
    ``set_session_profile`` is the host's reset. And a show only one
    side states is dropped where the *other* side hides its anchor,
    mode and all, so a mode it restricted there reverts to the
    target's allowance; the show grammar has no spelling for a mode
    without a re-open. Its own side's hide never drops it: a show is
    always stated against a hide, so reading the union would erase
    every show exception the other side simply never mentioned.

    Args:
        session (Session): the session the table lands on, already
            narrowed under the target's document.
        table (Session): the stored table, as ``Session.from_dict``
            read it.
    """
    modes = _merge_modes(session.mount_modes, table.mount_modes)
    hidden = _merge_hidden_paths(session.hidden_paths, table.hidden_paths)
    shown = _merge_shown(session.shown_paths, table.shown_paths,
                         session.mount_modes, table.mount_modes,
                         session.hidden_paths, table.hidden_paths)
    session.hidden_vars = _merge_hidden_vars(session.hidden_vars,
                                             table.hidden_vars)
    session.hide_reasons = _merge_groups(session.hide_reasons,
                                         table.hide_reasons)
    session.commands = _merge_commands(session.commands, table.commands)
    session.mount_modes = modes
    session.hidden_paths = hidden
    session.shown_paths = shown
