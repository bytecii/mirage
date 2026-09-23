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

from difflib import SequenceMatcher


def combined_lines(parents: list[list[str]], result: list[str],
                   dense: bool) -> list[str]:
    # Align parents once; each prefix column describes one parent.
    count = len(parents)
    masks = [['+'] * count for _ in result]
    deleted: list[list[tuple[str, int]]] = [[] for _ in range(len(result) + 1)]
    for parent, old in enumerate(parents):
        for tag, i, end, j, stop in SequenceMatcher(
                a=old, b=result, autojunk=False).get_opcodes():
            if tag == 'equal':
                for at in range(j, stop):
                    masks[at][parent] = ' '
            else:
                deleted[j].extend((line, parent) for line in old[i:end])
    rows: list[tuple[str, list[int], int]] = []
    for at in range(len(result) + 1):
        # Identical deletions share a row, retaining their order.
        grouped: list[tuple[str, list[str]]] = []
        for line, parent in deleted[at]:
            match = next((prefix for text, prefix in grouped
                          if text == line and prefix[parent] == ' '), None)
            if match is None:
                match = [' '] * count
                grouped.append((line, match))
            match[parent] = '-'
        for line, prefix in grouped:
            rows.append(
                (''.join(prefix) + line, [int(c == '-') for c in prefix], 0))
        if at < len(result):
            rows.append((''.join(masks[at]) + result[at],
                         [int(c == ' ') for c in masks[at]], 1))
    changed = [
        i for i, (line, _, _) in enumerate(rows) if line[:count] != ' ' * count
    ]
    if not changed:
        return []
    groups: list[list[int]] = []
    for at in changed:
        start, end = max(0, at - 3), min(len(rows), at + 4)
        if groups and start <= groups[-1][1]:
            groups[-1][1] = end
        else:
            groups.append([start, end])
    output = []
    for start, end in groups:
        block = rows[start:end]
        if dense and any(
                all(line[p] == ' ' for line, _, _ in block)
                for p in range(count)):
            continue
        ranges = []
        for p in range(count):
            offset = sum(consumed[p] for _, consumed, _ in rows[:start])
            length = sum(consumed[p] for _, consumed, _ in block)
            ranges.append(f'-{offset + int(length > 0)},{length}')
        offset = sum(added for _, _, added in rows[:start])
        length = sum(added for _, _, added in block)
        ranges.append(f'+{offset + int(length > 0)},{length}')
        marker = '@' * (count + 1)
        output.append(f'{marker} {" ".join(ranges)} {marker}\n')
        output.extend(line if line.endswith('\n') else line + '\n'
                      for line, _, _ in block)
    return output
