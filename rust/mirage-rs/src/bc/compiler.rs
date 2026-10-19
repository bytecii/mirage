use super::common::{BinaryOp, Budget, Builtin, MathFunction};
use super::source::{LINE_BITS, Line, bytes_of};

#[derive(Clone, Debug)]
pub(super) enum Place {
    Scale,
    InputBase,
    OutputBase,
    Last,
    Variable(String),
}

impl Place {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "scale" => Some(Self::Scale),
            "ibase" => Some(Self::InputBase),
            "obase" => Some(Self::OutputBase),
            "last" | "." => Some(Self::Last),
            name if !reserved(name) => Some(Self::Variable(name.to_owned())),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub(super) enum Call {
    Builtin(Builtin),
    Math(MathFunction),
    Undefined(String),
}

#[derive(Clone, Debug)]
pub(super) enum Instruction {
    Literal(String),
    Load(Place),
    Negate,
    Binary(BinaryOp),
    Store(Place),
    CompoundStore(Place, BinaryOp),
    Step(Place, i64, bool),
    Call(Call),
    Drop,
    Emit,
    Text(String),
    Newline,
    Halt,
}

#[derive(Clone, Debug)]
pub(super) struct LocatedInstruction {
    pub(super) operation: Instruction,
    pub(super) line: u64,
}

pub(super) struct Program {
    pub(super) instructions: Vec<LocatedInstruction>,
    pub(super) quits: bool,
}

pub(super) enum CompileResult {
    Program(Program),
    Refused {
        diagnostics: Vec<Diagnostic>,
        quits: bool,
    },
}

/// A refused statement: the line it is blamed on and why.
#[derive(Debug)]
pub(super) struct Diagnostic {
    line: u64,
    reason: String,
}

impl Diagnostic {
    /// The syntax error input ends on inside a statement. bc has moved past
    /// its last file by then, and blames standard input's first line.
    pub(super) fn end_of_input(sources: usize) -> Self {
        Self {
            line: (sources.saturating_sub(1) as u64) << LINE_BITS | 1,
            reason: "syntax error".to_owned(),
        }
    }

    /// The message, naming the line's source from `names` (one per file,
    /// then standard input) and its line within that source. A name is
    /// written as its bytes.
    pub(super) fn render(&self, names: &[Vec<u8>]) -> Vec<u8> {
        let source = usize::try_from(self.line >> LINE_BITS).unwrap_or(usize::MAX);
        let name = names
            .get(source)
            .map_or(&b"(standard_in)"[..], Vec::as_slice);
        let line = self.line & ((1 << LINE_BITS) - 1);
        let mut message = name.to_vec();
        message.extend_from_slice(format!(" {line}: {}\n", self.reason).as_bytes());
        message
    }
}

#[derive(Debug)]
enum TokenKind {
    Name(String),
    Number { text: String, valid: bool },
    Text { raw: String, printed: String },
    Symbol(String),
}

#[derive(Debug)]
struct Token {
    kind: TokenKind,
    line: u64,
    /// Where the token starts in its line's characters, which orders its
    /// syntax error among the illegal characters around it.
    offset: usize,
}

fn reserved(name: &str) -> bool {
    matches!(
        name,
        "scale"
            | "ibase"
            | "obase"
            | "last"
            | "sqrt"
            | "length"
            | "read"
            | "define"
            | "auto"
            | "return"
            | "if"
            | "else"
            | "while"
            | "for"
            | "break"
            | "continue"
            | "halt"
            | "quit"
            | "print"
            | "limits"
            | "warranty"
    )
}

fn binary(symbol: &str) -> Option<BinaryOp> {
    match symbol {
        "+" => Some(BinaryOp::Add),
        "-" => Some(BinaryOp::Subtract),
        "*" => Some(BinaryOp::Multiply),
        "/" => Some(BinaryOp::Divide),
        "%" => Some(BinaryOp::Remainder),
        "^" => Some(BinaryOp::Pow),
        _ => None,
    }
}

fn is_number(character: char) -> bool {
    character.is_ascii_digit() || character.is_ascii_uppercase() || character == '.'
}

fn is_name(character: char) -> bool {
    character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
}

#[derive(Default)]
enum Lexing {
    #[default]
    Start,
    Boundary {
        line: u64,
        final_line: bool,
        at: usize,
    },
    Name {
        text: String,
        line: u64,
    },
    Number {
        text: String,
        line: u64,
        dots: u32,
    },
    Text {
        raw: String,
        printed: String,
        escaped: bool,
        line: u64,
    },
}

#[derive(Clone)]
enum Task {
    Expr,
    Add,
    AddTail,
    Term,
    TermTail,
    Unary,
    Power,
    PowerTail,
    Atom,
    Close,
    Apply(Instruction),
    Print,
    PrintTail,
    End,
}

#[derive(Clone, Copy)]
struct Statement {
    start: usize,
    end: usize,
    incomplete_line: u64,
    /// Where the `;` or the end of the line that ends it sits.
    boundary: usize,
    /// Read only to recover from a syntax error, as bc's parser does: it
    /// reports nothing.
    silent: bool,
}

/// What bc has said about a line it scanned to an end that may not be the
/// line's: the diagnostics found from `reported` on, where the line stands,
/// whether it read `quit`, and whether it leaves a statement open.
pub(super) struct Scan {
    pub(super) diagnostics: Vec<Diagnostic>,
    pub(super) end: usize,
    pub(super) quits: bool,
    pub(super) open: bool,
}

pub(super) struct Compiler {
    source: Line,
    offset: usize,
    lexing: Lexing,
    tokens: Vec<Token>,
    statements: Vec<Statement>,
    token_start: usize,
    /// Where the token being lexed starts.
    started: usize,
    quote_index: usize,
    lexed: bool,
    quits: bool,
    statement: usize,
    pos: usize,
    tasks: Vec<Task>,
    instructions: Vec<LocatedInstruction>,
    /// Each diagnostic with where in the line it was found: bc reports an
    /// illegal character as it scans, and a syntax error at the token it
    /// could not take.
    diagnostics: Vec<(usize, Diagnostic)>,
    /// How many tokens stood before each `;`.
    separators: Vec<usize>,
    /// The token bc's parser went on from after the last syntax error.
    resumed: Option<usize>,
}

impl Compiler {
    pub(super) fn new(source: Line) -> Self {
        Self {
            source,
            offset: 0,
            lexing: Lexing::Start,
            tokens: Vec::new(),
            statements: Vec::new(),
            token_start: 0,
            started: 0,
            quote_index: 0,
            lexed: false,
            quits: false,
            statement: 0,
            pos: 0,
            tasks: Vec::new(),
            instructions: Vec::new(),
            diagnostics: Vec::new(),
            separators: Vec::new(),
            resumed: None,
        }
    }

    fn token(&mut self, kind: TokenKind, line: u64) {
        let offset = self.started;
        if matches!(&kind, TokenKind::Name(name) if name == "quit") {
            self.quits = true;
            if self.token_start != self.tokens.len() {
                self.tokens.push(Token { kind, line, offset });
            }
            self.offset = self.source.chars.len();
        } else {
            self.tokens.push(Token { kind, line, offset });
        }
    }

    /// A character bc cannot read: reported where it stands, one diagnostic
    /// per byte, and left out of the statement around it.
    fn illegal(&mut self, character: char, line: u64) {
        let mut buffer = [0; 4];
        for &byte in bytes_of(character, &mut buffer) {
            let shown = match byte {
                0..=0x1f => format!("^{}", char::from(byte + 0x40)),
                0x7f.. => format!("\\{byte:o}"),
                _ => char::from(byte).to_string(),
            };
            self.diagnostics.push((
                self.started,
                Diagnostic {
                    line,
                    reason: format!("illegal character: {shown}"),
                },
            ));
        }
    }

    /// Whether the characters at `offset` are a backslash and a newline,
    /// which bc reads as a space, or within a number as nothing.
    fn continues(&self, offset: usize) -> bool {
        self.source.chars.get(offset) == Some(&'\\')
            && self.source.chars.get(offset + 1) == Some(&'\n')
    }

    fn lex_step(&mut self) {
        let current = self.source.chars.get(self.offset).copied();
        match std::mem::take(&mut self.lexing) {
            Lexing::Boundary {
                line,
                final_line,
                at,
            } => {
                if self.token_start < self.tokens.len() {
                    self.statements.push(Statement {
                        start: self.token_start,
                        end: self.tokens.len(),
                        incomplete_line: line,
                        boundary: at,
                        silent: false,
                    });
                }
                if !final_line {
                    self.separators.push(self.tokens.len());
                }
                self.token_start = self.tokens.len();
                self.lexed = final_line;
            }
            Lexing::Name { mut text, line } => {
                if current.is_some_and(is_name) {
                    text.push(current.unwrap());
                    self.offset += 1;
                    self.lexing = Lexing::Name { text, line };
                } else {
                    self.token(TokenKind::Name(text), line);
                }
            }
            Lexing::Number {
                mut text,
                line,
                mut dots,
            } => {
                if self.continues(self.offset) {
                    self.offset += 2;
                    self.lexing = Lexing::Number { text, line, dots };
                } else if current.is_some_and(is_number) {
                    let character = current.unwrap();
                    text.push(character);
                    dots = dots.saturating_add(u32::from(character == '.'));
                    self.offset += 1;
                    self.lexing = Lexing::Number { text, line, dots };
                } else {
                    self.token(
                        TokenKind::Number {
                            text,
                            valid: dots <= 1,
                        },
                        line,
                    );
                }
            }
            Lexing::Text {
                mut raw,
                mut printed,
                mut escaped,
                line,
            } => {
                if let Some(character) = current {
                    self.offset += 1;
                    if character == '"' {
                        self.token(TokenKind::Text { raw, printed }, line);
                    } else {
                        raw.push(character);
                        if escaped {
                            if let Some(character) = escape(character) {
                                printed.push(character);
                            }
                            escaped = false;
                        } else if character == '\\' {
                            escaped = true;
                        } else {
                            printed.push(character);
                        }
                        self.lexing = Lexing::Text {
                            raw,
                            printed,
                            escaped,
                            line,
                        };
                    }
                } else {
                    self.illegal('"', line);
                }
            }
            Lexing::Start => {
                let Some(character) = current else {
                    self.lexing = Lexing::Boundary {
                        line: self.source.end_line.saturating_add(1),
                        final_line: true,
                        at: self.offset,
                    };
                    return;
                };
                let line = self.source.lines[self.offset];
                if self.continues(self.offset) {
                    self.offset += 2;
                    return;
                }
                self.started = self.offset;
                self.offset += 1;
                if matches!(character, ' ' | '\t') {
                    return;
                }
                if character == ';' {
                    self.lexing = Lexing::Boundary {
                        line,
                        final_line: false,
                        at: self.started,
                    };
                } else if character.is_ascii_lowercase() {
                    self.lexing = Lexing::Name {
                        text: character.to_string(),
                        line,
                    };
                } else if character.is_ascii_digit()
                    || character.is_ascii_uppercase()
                    || (character == '.'
                        && self
                            .source
                            .chars
                            .get(self.offset)
                            .is_some_and(|c| c.is_ascii_digit() || c.is_ascii_uppercase()))
                {
                    self.lexing = Lexing::Number {
                        text: character.to_string(),
                        line,
                        dots: u32::from(character == '.'),
                    };
                } else if character == '"' {
                    if self.source.quotes.get(self.quote_index) == Some(&(self.offset - 1)) {
                        self.quote_index += 1;
                        self.lexing = Lexing::Text {
                            raw: String::new(),
                            printed: String::new(),
                            escaped: false,
                            line,
                        };
                    } else {
                        self.illegal(character, line);
                    }
                } else {
                    let mut symbol = character.to_string();
                    if self.source.chars.get(self.offset).is_some_and(|next| {
                        (*next == character && matches!(character, '+' | '-' | '='))
                            || (*next == '='
                                && matches!(character, '+' | '-' | '*' | '/' | '%' | '^'))
                    }) {
                        symbol.push(self.source.chars[self.offset]);
                        self.offset += 1;
                    }
                    if ".+-*/%^=<>!()[]{},#".contains(character) {
                        self.token(TokenKind::Symbol(symbol), line);
                    } else {
                        self.illegal(character, line);
                    }
                }
            }
        }
    }

    fn end(&self) -> usize {
        self.statements[self.statement].end
    }

    fn symbol(&self, symbol: &str) -> bool {
        self.pos < self.end()
            && matches!(&self.tokens[self.pos].kind, TokenKind::Symbol(value) if value == symbol)
    }

    fn name(&self) -> Option<&str> {
        if self.pos >= self.end() {
            return None;
        }
        match &self.tokens[self.pos].kind {
            TokenKind::Name(name) => Some(name),
            TokenKind::Symbol(name) if name == "." => Some(name),
            _ => None,
        }
    }

    fn line(&self) -> u64 {
        self.tokens
            .get(self.pos)
            .map_or(self.statements[self.statement].incomplete_line, |token| {
                token.line
            })
    }

    fn emit(&mut self, operation: Instruction) {
        self.instructions.push(LocatedInstruction {
            operation,
            line: self.line(),
        });
    }

    fn fail(&mut self, at: Option<(u64, bool)>) {
        let statement = self.statements[self.statement];
        let incomplete = self.pos >= statement.end;
        let mut line = if incomplete {
            statement.incomplete_line
        } else {
            self.line()
        };
        if let Some((at_line, use_incomplete)) = at {
            if !use_incomplete || !incomplete {
                line = at_line;
            }
        }
        let found = if incomplete {
            statement.boundary
        } else {
            self.tokens[self.pos].offset
        };
        if !statement.silent {
            self.diagnostics.push((
                found,
                Diagnostic {
                    line,
                    reason: "syntax error".to_owned(),
                },
            ));
        }
        // At a token, `;` included, bc's parser goes on from the token as a
        // new statement, and drops it if that fails before taking anything.
        if found < self.source.chars.len() {
            let resumed = if statement.silent && self.pos == statement.start {
                self.pos + 1
            } else {
                self.pos.min(statement.end)
            };
            self.resumed = Some(resumed);
            if resumed < statement.end {
                self.statements.insert(
                    self.statement + 1,
                    Statement {
                        start: resumed,
                        silent: true,
                        ..statement
                    },
                );
            }
        }
        self.tasks.clear();
        self.statement += 1;
    }

    fn assignment(&mut self) -> Option<Instruction> {
        let place = Place::from_name(self.name()?)?;
        if self.pos + 1 >= self.end() {
            return None;
        }
        let TokenKind::Symbol(symbol) = &self.tokens[self.pos + 1].kind else {
            return None;
        };
        let instruction = if symbol == "=" {
            Instruction::Store(place)
        } else if symbol.ends_with('=') && symbol.len() == 2 {
            Instruction::CompoundStore(place, binary(&symbol[..1])?)
        } else {
            return None;
        };
        self.pos += 2;
        Some(instruction)
    }

    fn start_statement(&mut self) {
        self.pos = self.statements[self.statement].start;
        self.tasks.push(Task::End);
        if self.name() == Some("halt") && self.pos + 1 == self.end() {
            self.pos += 1;
            self.emit(Instruction::Halt);
        } else if matches!(&self.tokens[self.pos].kind, TokenKind::Text { .. }) {
            let TokenKind::Text { raw, .. } = std::mem::replace(
                &mut self.tokens[self.pos].kind,
                TokenKind::Symbol(String::new()),
            ) else {
                unreachable!()
            };
            self.emit(Instruction::Text(raw));
            self.pos += 1;
        } else if self.name() == Some("print") {
            self.pos += 1;
            self.tasks.push(Task::Print);
        } else if let Some(store) = self.assignment() {
            self.tasks.push(Task::Apply(Instruction::Drop));
            self.tasks.push(Task::Apply(store));
            self.tasks.push(Task::Expr);
        } else {
            self.tasks.push(Task::Apply(Instruction::Newline));
            self.tasks.push(Task::Apply(Instruction::Emit));
            self.tasks.push(Task::Expr);
        }
    }

    fn parse_step(&mut self, task: Task) {
        match task {
            Task::Expr => {
                if let Some(store) = self.assignment() {
                    self.tasks.push(Task::Apply(store));
                    self.tasks.push(Task::Expr);
                } else {
                    self.tasks.push(Task::Add);
                }
            }
            Task::Add => self.tasks.extend([Task::AddTail, Task::Term]),
            Task::AddTail => {
                if self.symbol("+") || self.symbol("-") {
                    let op = if self.symbol("+") {
                        BinaryOp::Add
                    } else {
                        BinaryOp::Subtract
                    };
                    self.pos += 1;
                    self.tasks.extend([
                        Task::AddTail,
                        Task::Apply(Instruction::Binary(op)),
                        Task::Term,
                    ]);
                }
            }
            Task::Term => self.tasks.extend([Task::TermTail, Task::Unary]),
            Task::TermTail => {
                if self.symbol("*") || self.symbol("/") || self.symbol("%") {
                    let TokenKind::Symbol(symbol) = &self.tokens[self.pos].kind else {
                        unreachable!()
                    };
                    let op = binary(symbol).unwrap();
                    self.pos += 1;
                    self.tasks.extend([
                        Task::TermTail,
                        Task::Apply(Instruction::Binary(op)),
                        Task::Unary,
                    ]);
                }
            }
            Task::Unary => {
                if self.symbol("++") || self.symbol("--") {
                    let delta = if self.symbol("++") { 1 } else { -1 };
                    self.pos += 1;
                    let target = self.name().map(str::to_owned);
                    if target.is_some() {
                        self.pos += 1;
                    }
                    if let Some(place) = target.as_deref().and_then(Place::from_name) {
                        self.emit(Instruction::Step(place, delta, false));
                    } else {
                        self.fail(None);
                    }
                } else if self.symbol("-") {
                    self.pos += 1;
                    self.tasks
                        .extend([Task::Apply(Instruction::Negate), Task::Unary]);
                } else {
                    self.tasks.push(Task::Power);
                }
            }
            Task::Power => self.tasks.extend([Task::PowerTail, Task::Atom]),
            Task::PowerTail => {
                if self.symbol("^") {
                    self.pos += 1;
                    self.tasks
                        .extend([Task::Apply(Instruction::Binary(BinaryOp::Pow)), Task::Unary]);
                }
            }
            Task::Atom => {
                if self.symbol("(") {
                    self.pos += 1;
                    self.tasks.extend([Task::Close, Task::Expr]);
                } else if self.pos < self.end()
                    && matches!(&self.tokens[self.pos].kind, TokenKind::Number { .. })
                {
                    let TokenKind::Number { text: raw, valid } = std::mem::replace(
                        &mut self.tokens[self.pos].kind,
                        TokenKind::Symbol(String::new()),
                    ) else {
                        unreachable!()
                    };
                    if !valid {
                        self.fail(Some((self.line(), false)));
                    } else {
                        self.emit(Instruction::Literal(raw));
                        self.pos += 1;
                    }
                } else if let Some(name) = self.name().map(str::to_owned) {
                    let start_line = self.line();
                    self.pos += 1;
                    let builtin = match name.as_str() {
                        "sqrt" => Some(Builtin::Sqrt),
                        "length" => Some(Builtin::Length),
                        "scale" => Some(Builtin::Scale),
                        _ => None,
                    };
                    if self.symbol("(") && (builtin.is_some() || (!reserved(&name) && name != "."))
                    {
                        self.pos += 1;
                        let call = if let Some(function) = builtin {
                            Call::Builtin(function)
                        } else {
                            match name.as_str() {
                                "s" => Call::Math(MathFunction::Sin),
                                "c" => Call::Math(MathFunction::Cos),
                                "a" => Call::Math(MathFunction::Atan),
                                "l" => Call::Math(MathFunction::Log),
                                "e" => Call::Math(MathFunction::Exp),
                                _ => Call::Undefined(name),
                            }
                        };
                        self.tasks.extend([
                            Task::Apply(Instruction::Call(call)),
                            Task::Close,
                            Task::Expr,
                        ]);
                    } else if builtin.is_some() && name != "scale" {
                        self.fail(Some((start_line, true)));
                    } else if let Some(place) = Place::from_name(&name) {
                        if self.symbol("++") || self.symbol("--") {
                            let delta = if self.symbol("++") { 1 } else { -1 };
                            self.emit(Instruction::Step(place, delta, true));
                            self.pos += 1;
                        } else {
                            self.emit(Instruction::Load(place));
                        }
                    } else {
                        self.fail(Some((start_line, false)));
                    }
                } else {
                    self.fail(None);
                }
            }
            Task::Close => {
                if self.symbol(")") {
                    self.pos += 1;
                } else {
                    self.fail(None);
                }
            }
            Task::Apply(instruction) => self.emit(instruction),
            Task::Print => {
                self.tasks.push(Task::PrintTail);
                if self.pos < self.end()
                    && matches!(&self.tokens[self.pos].kind, TokenKind::Text { .. })
                {
                    let TokenKind::Text { printed, .. } = std::mem::replace(
                        &mut self.tokens[self.pos].kind,
                        TokenKind::Symbol(String::new()),
                    ) else {
                        unreachable!()
                    };
                    self.emit(Instruction::Text(printed));
                    self.pos += 1;
                } else {
                    self.tasks
                        .extend([Task::Apply(Instruction::Emit), Task::Expr]);
                }
            }
            Task::PrintTail => {
                if self.symbol(",") {
                    self.pos += 1;
                    self.tasks.push(Task::Print);
                }
            }
            Task::End => {
                if self.pos < self.end() {
                    self.fail(None);
                } else {
                    self.statement += 1;
                }
            }
        }
    }

    pub(super) fn advance(&mut self, budget: &mut Budget) -> bool {
        while budget.take() {
            if !self.lexed {
                self.lex_step();
            } else if let Some(task) = self.tasks.pop() {
                self.parse_step(task);
            } else if self.statement < self.statements.len() {
                self.start_statement();
            } else {
                return true;
            }
        }
        false
    }

    /// The line compiled. A diagnostic found before `reported` was written
    /// when its file ended (`scanned`), so it is left out, though it still
    /// refuses the line.
    pub(super) fn finish(mut self, reported: usize) -> CompileResult {
        if self.diagnostics.is_empty() {
            CompileResult::Program(Program {
                instructions: self.instructions,
                quits: self.quits,
            })
        } else {
            self.diagnostics.sort_by_key(|(found, _)| *found);
            CompileResult::Refused {
                diagnostics: self
                    .diagnostics
                    .into_iter()
                    .filter(|(found, _)| *found >= reported)
                    .map(|(_, diagnostic)| diagnostic)
                    .collect(),
                quits: self.quits,
            }
        }
    }

    /// The line scanned to the end of a file, which the next input may
    /// still continue, or to the end of input. A statement the end leaves
    /// open is no error here, and nothing runs.
    pub(super) fn scanned(mut self, reported: usize) -> Scan {
        let end = self.source.chars.len();
        self.diagnostics.sort_by_key(|(found, _)| *found);
        // After a syntax error bc's parser says nothing more until it has
        // taken three tokens.
        let open = !self.quits
            && self.resumed.map_or(
                !self.tokens.is_empty() || !self.separators.is_empty(),
                |resumed| {
                    let taken = self.tokens.len().saturating_sub(resumed)
                        + self.separators.iter().filter(|at| **at > resumed).count();
                    taken >= 3
                },
            );
        Scan {
            diagnostics: self
                .diagnostics
                .into_iter()
                .filter(|(found, _)| (reported..end).contains(found))
                .map(|(_, diagnostic)| diagnostic)
                .collect(),
            end,
            quits: self.quits,
            open,
        }
    }
}

fn escape(character: char) -> Option<char> {
    match character {
        'a' => Some('\x07'),
        'b' => Some('\x08'),
        'f' => Some('\x0c'),
        'n' => Some('\n'),
        'q' => Some('"'),
        'r' => Some('\r'),
        't' => Some('\t'),
        '\\' => Some('\\'),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bc::source::{FrontEvent, FrontStep, Source};

    fn rendered(diagnostics: &[Diagnostic]) -> Vec<String> {
        diagnostics
            .iter()
            .map(|diagnostic| String::from_utf8_lossy(&diagnostic.render(&[])).into_owned())
            .collect()
    }

    fn compile(input: &str) -> CompileResult {
        let mut source = Source::new();
        source.feed(input.as_bytes());
        source.finish();
        let line = loop {
            match source.advance(&mut Budget::new(3)) {
                FrontStep::Event(FrontEvent::Program(line)) => break line,
                FrontStep::Pending => {}
                _ => panic!("expected logical line"),
            }
        };
        let mut compiler = Compiler::new(line);
        while !compiler.advance(&mut Budget::new(3)) {}
        compiler.finish(0)
    }

    #[test]
    fn syntax_refuses_each_bad_statement_before_execution() {
        let CompileResult::Refused { diagnostics, quits } = compile("x=5;1/0;1 2;1+\n") else {
            panic!("expected refusal")
        };
        assert!(!quits);
        assert_eq!(
            rendered(&diagnostics),
            [
                "(standard_in) 1: syntax error\n",
                "(standard_in) 2: syntax error\n"
            ]
        );
    }

    #[test]
    fn input_depth_uses_parser_tasks() {
        let input = format!("{}7{}\n", "(".repeat(32_000), ")".repeat(32_000));
        let CompileResult::Program(program) = compile(&input) else {
            panic!("expected program")
        };
        assert_eq!(program.instructions.len(), 3);
    }

    #[test]
    fn quit_cuts_lexically_but_halt_is_an_instruction() {
        let CompileResult::Program(program) = compile("print \"quit\";1+1;quit;@\n") else {
            panic!("expected program")
        };
        assert!(program.quits);
        let CompileResult::Refused { diagnostics, .. } = compile("1+1;halt;1 2\n") else {
            panic!("expected refusal")
        };
        assert_eq!(rendered(&diagnostics), ["(standard_in) 1: syntax error\n"]);
    }
}
