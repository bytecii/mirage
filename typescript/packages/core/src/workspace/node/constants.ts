// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { NodeType as NT } from '../../shell/types.ts'
import { NodeKind } from '../../shell/syntax/node_kind.ts'
import { VarAttr } from '../../shell/variable.ts'

export const STREAMING_KINDS: ReadonlySet<NodeKind> = new Set([
  NodeKind.PROGRAM,
  NodeKind.COMPOUND,
  NodeKind.LIST,
  NodeKind.SUBSHELL,
  NodeKind.IF,
  NodeKind.FOR,
  NodeKind.CFOR,
  NodeKind.SELECT,
  NodeKind.WHILE,
  NodeKind.UNTIL,
  NodeKind.CASE,
  NodeKind.NEGATED,
])

export const SUBSCRIPT_LITERAL_TYPES: ReadonlySet<string> = new Set([NT.WORD, NT.NUMBER, NT.ERROR])

// The options GNU declare accepts; readers and writers resolve -n through deref.
export const DECLARE_LETTERS: ReadonlySet<string> = new Set('aAfFgiIlnprtux')

export const DECLARE_USAGE =
  'declare: usage: declare [-aAfFgiIlnrtux] [name[=value] ...] or declare -p [-aAfFilnrtux] [name ...]'

// The stored attributes a `-letter` / `+letter` toggles.
export const ATTR_LETTERS: ReadonlyMap<string, VarAttr> = new Map([
  ['i', VarAttr.Integer],
  ['l', VarAttr.Lower],
  ['u', VarAttr.Upper],
  ['n', VarAttr.Nameref],
  ['t', VarAttr.Trace],
  ['x', VarAttr.Export],
  ['r', VarAttr.Readonly],
])
