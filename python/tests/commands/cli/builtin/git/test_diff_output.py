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

import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path

import pytest

from mirage.commands.cli.builtin.git import GIT
from mirage.version import __version__
from tests.commands.cli.builtin.git.conftest import mounted

FIXTURE = Path(__file__).resolve().parents[6] / 'integ/fixtures/git'
FORMS = json.loads((FIXTURE / 'read-only.json').read_text())
ENV = {
    **os.environ, 'GIT_CONFIG_GLOBAL': '/dev/null',
    'GIT_CONFIG_NOSYSTEM': '1'
}


@pytest.fixture(scope='module')
def readonly_repo(tmp_path_factory):
    path = tmp_path_factory.mktemp('readonly')
    subprocess.run(['bash', str(FIXTURE / 'read-only.sh'),
                    str(path)],
                   check=True,
                   env=ENV)
    return path


@pytest.mark.asyncio
@pytest.mark.parametrize('form', FORMS)
async def test_native_git(readonly_repo, form):
    native = subprocess.run(
        ['git', '-C', str(readonly_repo), *shlex.split(form)],
        capture_output=True,
        env=ENV)
    with mounted(readonly_repo) as ws:
        ws.register_cli('git', GIT)
        got = await ws.shell('git -C /repo ' + form)
    assert (got.exit_code, got.stdout or b'', got.stderr
            or b'') == (native.returncode, native.stdout, native.stderr)


@pytest.mark.asyncio
@pytest.mark.parametrize('form', ['--version', 'version', '-v'])
async def test_version_without_repository(git_ws, form):
    result = await git_ws.shell('git ' + form)
    assert result.exit_code == 0
    assert result.stdout == f"git version {__version__} (Mirage)\n".encode()


@pytest.mark.asyncio
@pytest.mark.parametrize('flag', ['', '--find-renames', '--no-renames'])
async def test_rename_config(readonly_repo, tmp_path, flag):
    path = tmp_path / 'repo'
    shutil.copytree(readonly_repo, path)
    subprocess.run(['git', '-C',
                    str(path), 'config', 'diff.renames', 'false'],
                   check=True)
    form = f'show --format= --name-status {flag} HEAD~2'
    native = subprocess.run(
        ['git', '-C', str(path), *shlex.split(form)],
        capture_output=True,
        env=ENV)
    with mounted(path) as ws:
        ws.register_cli('git', GIT)
        got = await ws.shell('git -C /repo ' + form)
    assert (got.exit_code, got.stdout or b'', got.stderr
            or b'') == (native.returncode, native.stdout, native.stderr)
