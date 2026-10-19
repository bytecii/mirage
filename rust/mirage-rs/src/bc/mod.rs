mod common;
mod compiler;
mod math;
mod numbers;
#[cfg(test)]
mod numeric_tests;
mod render;
mod source;
mod vm;

use crate::{Stream, StreamError, parse_config};
use common::{Budget, Config};
use compiler::{CompileResult, Compiler, Diagnostic};
use source::{FrontEvent, FrontStep, Source};
use vm::Vm;

const ACTIONS_PER_CALL: u32 = 4096;

pub(super) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    let mut names = config.files;
    names.push(b"(standard_in)".to_vec());
    Ok(Box::new(Bc {
        source: Source::new(),
        names,
        files_ended: 0,
        compiler: None,
        scanner: None,
        scan_due: false,
        reported: 0,
        closing: None,
        vm: Vm::new(config.math_mode, config.line_length.as_deref()),
        stderr: Vec::new(),
        stopped: false,
        ended: false,
        needs_input: true,
    }))
}

enum Closing {
    Input,
    Comment,
}

struct Bc {
    source: Source,
    /// The files' names, then standard input's.
    names: Vec<Vec<u8>>,
    files_ended: usize,
    compiler: Option<Compiler>,
    /// The line a file left unended, compiled only for what bc reports
    /// as it scans: it does not wait for the next input to say it.
    scanner: Option<Compiler>,
    /// A file has ended, so the line it leaves is due a scan.
    scan_due: bool,
    /// How much of the line being read a scan has reported.
    reported: usize,
    /// How input ended, while the scan of the line it left runs.
    closing: Option<Closing>,
    vm: Vm,
    stderr: Vec<u8>,
    stopped: bool,
    ended: bool,
    needs_input: bool,
}

impl Bc {
    fn advance(&mut self, output: &mut Vec<u8>) {
        let mut budget = Budget::new(ACTIONS_PER_CALL);
        loop {
            if self.vm.busy() {
                self.vm.advance(&mut budget, output, &mut self.stderr);
                if self.vm.busy() {
                    return;
                }
                if self.vm.halted() {
                    self.stopped = true;
                }
            }
            if let Some(compiler) = &mut self.compiler {
                if !compiler.advance(&mut budget) {
                    return;
                }
                let result = self
                    .compiler
                    .take()
                    .expect("completed compiler")
                    .finish(std::mem::take(&mut self.reported));
                match result {
                    CompileResult::Program(program) => {
                        self.stopped |= program.quits;
                        self.vm.start(program);
                    }
                    CompileResult::Refused { diagnostics, quits } => {
                        self.stopped |= quits;
                        for diagnostic in diagnostics {
                            self.stderr
                                .extend_from_slice(&diagnostic.render(&self.names));
                        }
                    }
                }
                continue;
            }
            if let Some(scanner) = &mut self.scanner {
                if !scanner.advance(&mut budget) {
                    return;
                }
                let scan = self
                    .scanner
                    .take()
                    .expect("completed scan")
                    .scanned(self.reported);
                for diagnostic in &scan.diagnostics {
                    self.stderr
                        .extend_from_slice(&diagnostic.render(&self.names));
                }
                self.reported = scan.end;
                // bc quits as it reads `quit`, before it opens the next file.
                self.stopped |= scan.quits;
                if let Some(closing) = self.closing.take() {
                    if matches!(closing, Closing::Comment) && !scan.quits {
                        self.stderr
                            .extend_from_slice(b"EOF encountered in a comment.\n");
                    }
                    if scan.open {
                        let diagnostic = Diagnostic::end_of_input(self.names.len());
                        self.stderr
                            .extend_from_slice(&diagnostic.render(&self.names));
                    }
                    self.ended = true;
                }
                continue;
            }
            if self.stopped || self.ended {
                return;
            }
            match self.source.advance(&mut budget) {
                FrontStep::Pending => {
                    self.needs_input = false;
                    return;
                }
                FrontStep::NeedsInput => {
                    if std::mem::take(&mut self.scan_due) {
                        if let Some(line) = self.source.scanned() {
                            self.scanner = Some(Compiler::new(line));
                            continue;
                        }
                    }
                    self.needs_input = true;
                    return;
                }
                FrontStep::Event(FrontEvent::Program(line)) => {
                    self.needs_input = false;
                    self.compiler = Some(Compiler::new(line));
                }
                // Input has ended. bc says what it scanned of the last line,
                // runs none of it, and calls a statement left open a syntax
                // error.
                FrontStep::Event(FrontEvent::Unended(line)) => {
                    self.needs_input = false;
                    self.closing = Some(Closing::Input);
                    self.scanner = Some(Compiler::new(line));
                }
                FrontStep::Event(FrontEvent::EofInComment(line)) => {
                    self.needs_input = false;
                    self.closing = Some(Closing::Comment);
                    self.scanner = Some(Compiler::new(line));
                }
                FrontStep::Event(FrontEvent::End) => self.ended = true,
            }
        }
    }
}

impl Stream for Bc {
    fn feed(&mut self, input: &[u8], output: &mut Vec<u8>) -> Result<(), StreamError> {
        if !self.stopped && !self.ended {
            self.source.feed(input);
            self.needs_input = false;
        }
        self.advance(output);
        Ok(())
    }

    /// File `index` has ended; the host feeds the files in order and then
    /// standard input, reading each only once bc still runs.
    fn end_input(&mut self, index: usize, output: &mut Vec<u8>) -> Result<(), StreamError> {
        if index != self.files_ended || index + 1 >= self.names.len() {
            return Err(StreamError::new("bc files end in order"));
        }
        self.files_ended += 1;
        self.source.end_file();
        self.scan_due = true;
        self.needs_input = false;
        self.advance(output);
        Ok(())
    }

    fn finish(&mut self, output: &mut Vec<u8>) -> Result<(), StreamError> {
        self.source.finish();
        self.needs_input = false;
        self.advance(output);
        Ok(())
    }

    fn busy(&self) -> bool {
        self.vm.busy()
            || self.compiler.is_some()
            || self.scanner.is_some()
            || (!self.stopped && !self.ended && !self.needs_input && self.source.busy())
    }

    fn drain(&mut self, output: &mut Vec<u8>) -> Result<(), StreamError> {
        self.advance(output);
        Ok(())
    }

    fn done(&self) -> bool {
        self.stopped || self.ended
    }

    fn take_stderr(&mut self, output: &mut Vec<u8>) {
        output.append(&mut self.stderr);
    }
}
