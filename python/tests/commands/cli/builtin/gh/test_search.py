from unittest.mock import AsyncMock

import pytest

from mirage.commands.cli.builtin.gh.search import search_cmd, search_spec
from mirage.commands.cli.types import CLIInvocation
from mirage.core.github.config import GhConfig


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind,flags,expected",
    [('issues', {
        'label': ['bug,help wanted'],
        'repo': ['integ/a', 'other/b'],
        'locked': 'false',
        'no_assignee': True
    }, '"two words" is:unlocked label:"help wanted" label:bug '
      'no:assignee repo:integ/a repo:other/b type:issue'),
     ('prs', {
         'app': 'bot',
         'review_requested': 'integ/team',
         'merged': 'false',
         'draft': True
     }, '"two words" author:app/bot draft:true is:unmerged '
      'team-review-requested:integ/team type:pr'),
     ('repos', {
         'owner': ['integ,other'],
         'include_forks': 'only',
         'number_topics': '>2'
     }, '"two words" fork:only topics:>2 user:integ user:other'),
     ('code', {
         'match': ['file'],
         'extension': 'ts',
         'repo': ['integ/a']
     }, '"two words" extension:ts in:file repo:integ/a'),
     ('commits', {
         'author_name': 'A Person',
         'merge': 'false',
         'visibility': ['public']
     }, '"two words" author-name:"A Person" is:public merge:false')])
async def test_search_qualifiers_match_native_gh(monkeypatch, kind, flags,
                                                 expected):
    fetch = AsyncMock(return_value=[])
    monkeypatch.setitem(search_cmd.__globals__, "search", fetch)
    leaf = next(item for item in search_spec().subcommands
                if item.name == kind)
    await search_cmd(
        kind,
        CLIInvocation(config=GhConfig(token="t"),
                      argv=("search", kind, "two words"),
                      texts=("two words", ),
                      flags={
                          **flags, "limit": "30",
                          "json": "url"
                      },
                      spec=leaf))
    assert fetch.await_args.args[2] == expected
