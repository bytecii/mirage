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


import pytest


@pytest.mark.parametrize(
    "cmd",
    [
        pytest.param("true; echo $?", id="true"),
        pytest.param("false; echo $?", id="false"),
        pytest.param("true | false; echo $?", id="pipe_last"),
        pytest.param("false | true; echo $?", id="pipe_success"),
        pytest.param("true && echo $?", id="and_success"),
        pytest.param("false && echo $?", id="and_short_circuit"),
        pytest.param("false || echo $?", id="or_fallback"),
        pytest.param("true || echo $?", id="or_short_circuit"),
        pytest.param("true && false; echo $?", id="and_then_semi"),
        pytest.param("false || true; echo $?", id="or_then_semi"),
        pytest.param("if true; then echo $?; fi", id="if_true"),
        pytest.param("if false; then echo a; else echo $?; fi", id="if_else"),
        pytest.param("false; true; echo $?", id="semicolon_chain_true"),
        pytest.param("true; false; echo $?", id="semicolon_chain_false"),
        pytest.param("false; if true; then echo $?; fi", id="if_resets"),
        pytest.param("true; (false); echo $?", id="subshell"),
        pytest.param(
            "false; while false; do echo x; done; echo $?", id="while_no_body"
        ),
        pytest.param("! true; echo $?", id="negation_true"),
        pytest.param("! false; echo $?", id="negation_false"),
    ],
)
def test_exit_code(shell, cmd):
    assert shell.mirage(cmd) == shell.native(cmd)
