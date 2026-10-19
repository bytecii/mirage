use std::collections::VecDeque;

use super::common::Budget;

/// A line number carries the index of its source above these bits, so
/// lines stay ordered across sources and the low bits count within one.
pub(super) const LINE_BITS: u32 = 32;

/// bc reads bytes: one that is not part of a whole UTF-8 character rides
/// as a character of its own among the last 128 code points, so it reaches
/// the output and the diagnostics as the byte it was.
const RAW: u32 = 0x10_ff00;

fn raw(byte: u8) -> char {
    char::from_u32(RAW + u32::from(byte)).expect("a raw byte maps to a code point")
}

/// The bytes `character` stands for.
pub(super) fn bytes_of(character: char, buffer: &mut [u8; 4]) -> &[u8] {
    match u32::from(character).checked_sub(RAW + 0x80) {
        Some(offset) => {
            buffer[0] = 0x80 + offset as u8;
            &buffer[..1]
        }
        None => character.encode_utf8(buffer).as_bytes(),
    }
}

pub(super) struct Line {
    pub(super) chars: Vec<char>,
    pub(super) lines: Vec<u64>,
    pub(super) end_line: u64,
    pub(super) quotes: Vec<usize>,
}

pub(super) enum FrontEvent {
    Program(Line),
    EofInComment,
    End,
}

pub(super) enum FrontStep {
    Pending,
    NeedsInput,
    Event(FrontEvent),
}

#[derive(Default)]
enum Mode {
    #[default]
    Normal,
    Slash,
    Hash,
    Block,
    BlockStar,
    Quote(VecDeque<char>),
}

#[derive(Default)]
pub(super) struct Source {
    bytes: VecDeque<u8>,
    replay: VecDeque<char>,
    quote_copy: VecDeque<char>,
    mode: Mode,
    chars: Vec<char>,
    lines: Vec<u64>,
    line: u64,
    quotes: Vec<usize>,
    eof: bool,
    ended: bool,
    origin: u64,
    received: u64,
    taken: u64,
    /// Where each file ended so far stops, counted in bytes from the first.
    starts: VecDeque<u64>,
}

impl Source {
    /// A source reading files ahead of standard input, as one program: a
    /// statement or block comment a file leaves open runs on into the next.
    pub(super) fn new() -> Self {
        Self {
            line: 1,
            ..Self::default()
        }
    }

    fn at(&self) -> u64 {
        (self.origin << LINE_BITS) | self.line
    }

    fn at_boundary(&self) -> bool {
        self.starts
            .front()
            .is_some_and(|start| *start <= self.taken)
    }

    /// Move to the next source; it counts its lines from one.
    fn cross(&mut self) {
        self.starts.pop_front();
        self.origin += 1;
        self.line = 1;
    }

    fn pop(&mut self) {
        self.bytes.pop_front();
        self.taken += 1;
    }

    pub(super) fn feed(&mut self, input: &[u8]) {
        if !self.eof && !self.ended {
            self.bytes.extend(input);
            self.received += input.len() as u64;
        }
    }

    /// The file being fed has ended; the next byte is the next source's.
    pub(super) fn end_file(&mut self) {
        self.starts.push_back(self.received);
    }

    pub(super) fn finish(&mut self) {
        self.eof = true;
    }

    pub(super) fn busy(&self) -> bool {
        !self.ended
            && (!self.quote_copy.is_empty()
                || !self.replay.is_empty()
                || !self.bytes.is_empty()
                || self.at_boundary()
                || self.eof)
    }

    fn append(&mut self, character: char) {
        self.chars.push(character);
        self.lines.push(self.at());
    }

    fn take_line(&mut self) -> Line {
        Line {
            chars: std::mem::take(&mut self.chars),
            lines: std::mem::take(&mut self.lines),
            end_line: self.at(),
            quotes: std::mem::take(&mut self.quotes),
        }
    }

    fn decode(&mut self) -> Option<char> {
        if let Some(character) = self.replay.pop_front() {
            return Some(character);
        }
        let first = *self.bytes.front()?;
        if first < 0x80 {
            self.pop();
            return Some(char::from(first));
        }
        let length = match first {
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => 0,
        };
        let mut value = u32::from(first & (0x7f >> length));
        let mut consumed = 1;
        // A character never runs on into the next file.
        let room = self
            .starts
            .front()
            .map_or(u64::MAX, |start| start.saturating_sub(self.taken));
        while consumed < length {
            if consumed as u64 >= room {
                break;
            }
            let Some(&next) = self.bytes.get(consumed) else {
                if !self.eof {
                    return None;
                }
                break;
            };
            let valid = match (first, consumed) {
                (0xe0, 1) => (0xa0..=0xbf).contains(&next),
                (0xed, 1) => (0x80..=0x9f).contains(&next),
                (0xf0, 1) => (0x90..=0xbf).contains(&next),
                (0xf4, 1) => (0x80..=0x8f).contains(&next),
                _ => (0x80..=0xbf).contains(&next),
            };
            if !valid {
                break;
            }
            value = (value << 6) | u32::from(next & 0x3f);
            consumed += 1;
        }
        let whole = (length != 0 && consumed == length)
            .then(|| char::from_u32(value))
            .flatten()
            .filter(|character| u32::from(*character) < RAW + 0x80);
        if let Some(character) = whole {
            for _ in 0..consumed {
                self.pop();
            }
            return Some(character);
        }
        // Not a whole character: its first byte stands alone.
        self.pop();
        Some(raw(first))
    }

    pub(super) fn advance(&mut self, budget: &mut Budget) -> FrontStep {
        if self.ended {
            return FrontStep::NeedsInput;
        }
        while budget.take() {
            if let Some(character) = self.quote_copy.pop_front() {
                self.append(character);
                if character == '\n' {
                    self.line = self.line.saturating_add(1);
                }
                continue;
            }
            if self.replay.is_empty() && self.at_boundary() {
                // bc's scanner ends every token with its file: an open
                // string or `/` is an illegal character or an operator
                // there, and a `#` comment ends; only a block comment runs
                // on into the next file.
                match std::mem::take(&mut self.mode) {
                    Mode::Quote(mut pending) => {
                        self.append('"');
                        pending.pop_front();
                        self.replay = pending;
                        continue;
                    }
                    mode @ (Mode::Block | Mode::BlockStar) => self.mode = mode,
                    mode => {
                        if matches!(mode, Mode::Slash) {
                            self.append('/');
                        }
                        if !self.chars.is_empty() {
                            self.append(' ');
                        }
                    }
                }
                self.cross();
                continue;
            }
            let Some(character) = self.decode() else {
                if !self.eof {
                    return FrontStep::NeedsInput;
                }
                match std::mem::take(&mut self.mode) {
                    Mode::Quote(mut pending) => {
                        self.append('"');
                        pending.pop_front();
                        self.replay = pending;
                        continue;
                    }
                    Mode::Slash => self.append('/'),
                    Mode::Block | Mode::BlockStar => {
                        self.ended = true;
                        self.chars.clear();
                        self.lines.clear();
                        return FrontStep::Event(FrontEvent::EofInComment);
                    }
                    _ => {}
                }
                if !self.chars.is_empty() {
                    let line = self.take_line();
                    return FrontStep::Event(FrontEvent::Program(line));
                }
                self.ended = true;
                return FrontStep::Event(FrontEvent::End);
            };
            let mode = std::mem::take(&mut self.mode);
            match mode {
                Mode::Quote(mut pending) => {
                    pending.push_back(character);
                    if character == '"' {
                        self.quotes.push(self.chars.len());
                        self.quote_copy = pending;
                    } else {
                        self.mode = Mode::Quote(pending);
                    }
                }
                Mode::Slash => {
                    if character == '*' {
                        self.mode = Mode::Block;
                    } else {
                        self.append('/');
                        self.replay.push_front(character);
                    }
                }
                Mode::Hash => {
                    if character == '\n' {
                        let line = self.take_line();
                        self.line = self.line.saturating_add(1);
                        return FrontStep::Event(FrontEvent::Program(line));
                    }
                    self.mode = Mode::Hash;
                }
                Mode::Block | Mode::BlockStar => {
                    if matches!(mode, Mode::BlockStar) && character == '/' {
                        self.append(' ');
                    } else {
                        if character == '\n' {
                            self.line = self.line.saturating_add(1);
                        }
                        self.mode = if character == '*' {
                            Mode::BlockStar
                        } else {
                            Mode::Block
                        };
                    }
                }
                Mode::Normal => match character {
                    '"' => self.mode = Mode::Quote(VecDeque::from(['"'])),
                    '/' => self.mode = Mode::Slash,
                    '#' => self.mode = Mode::Hash,
                    // A backslash before a newline continues the line; the
                    // compiler reads the pair as a space, or within a number
                    // as nothing.
                    '\n' if self.chars.last() == Some(&'\\') => {
                        self.append('\n');
                        self.line = self.line.saturating_add(1);
                    }
                    '\n' => {
                        let line = self.take_line();
                        self.line = self.line.saturating_add(1);
                        return FrontStep::Event(FrontEvent::Program(line));
                    }
                    _ => self.append(character),
                },
            }
        }
        FrontStep::Pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(input: &[u8], width: usize) -> Vec<Line> {
        let mut source = Source::new();
        let mut lines = Vec::new();
        for chunk in input.chunks(width) {
            source.feed(chunk);
            collect(&mut source, &mut lines);
        }
        source.finish();
        collect(&mut source, &mut lines);
        lines
    }

    fn collect(source: &mut Source, lines: &mut Vec<Line>) {
        loop {
            let mut budget = Budget::new(2);
            match source.advance(&mut budget) {
                FrontStep::Event(FrontEvent::Program(line)) => lines.push(line),
                FrontStep::Pending => {}
                FrontStep::NeedsInput | FrontStep::Event(FrontEvent::End) => break,
                FrontStep::Event(FrontEvent::EofInComment) => panic!("unexpected comment EOF"),
            }
        }
    }

    #[test]
    fn chunks_preserve_strings_and_comment_locations() {
        let input = b"1/*comment\n*/+2#rest\nprint \"a#/*;\nxyz\"\n";
        for width in 1..=input.len() {
            let lines = scan(input, width);
            assert_eq!(lines.len(), 2);
            assert_eq!(lines[0].chars.iter().collect::<String>(), "1 +2");
            assert_eq!(lines[0].lines, [1, 2, 2, 2]);
            assert_eq!(
                lines[1].chars.iter().collect::<String>(),
                "print \"a#/*;\nxyz\""
            );
            assert_eq!(lines[1].end_line, 4);
        }
    }

    #[test]
    fn bytes_outside_whole_characters_come_back_one_by_one() {
        // é and 中, then sequences that are not whole characters, the last
        // spelling a code point the raw bytes ride on.
        let input: &[u8] =
            b"\xc3\xa9 \xe4\xb8\xad\xe0\x80\x80 \xed\xa0\x80 \xf4\x90\x80\x80 \xe2\x82x \xf0\x9f \xf4\x8f\xbe\x80";
        for width in 1..=input.len() {
            let lines = scan(input, width);
            let mut buffer = [0; 4];
            let kept: Vec<u8> = lines[0]
                .chars
                .iter()
                .flat_map(|c| bytes_of(*c, &mut buffer).to_vec())
                .collect();
            assert_eq!(kept, input);
            assert_eq!(lines[0].chars[..3], ['\u{e9}', ' ', '\u{4e2d}']);
            assert_eq!(lines[0].chars.len(), 3 + input.len() - 6);
        }
    }

    #[test]
    fn unmatched_quote_replays_comments_and_newlines() {
        let lines = scan(b"1+\"a#c\n2+2\n", 1);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].chars.iter().collect::<String>(), "1+\"a");
        assert_eq!(lines[1].chars.iter().collect::<String>(), "2+2");
        assert!(lines[0].quotes.is_empty());
    }
}
