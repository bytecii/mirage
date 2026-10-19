use std::sync::OnceLock;

use regex_syntax::hir::{
    Class as HirClass, ClassBytes, ClassBytesRange, ClassUnicode, ClassUnicodeRange, Hir,
};

use super::parse::{Class, Item, Set, Unit};
use crate::generated::unicode_classes as classes;

/// What a set, `.` or a caseless literal matches: bytes outside a UTF-8
/// locale, characters in one, where a byte that is no part of a character
/// matches no set at all.
#[derive(Clone, Debug)]
pub(crate) enum Members {
    Bytes(ClassBytes),
    Chars(ClassUnicode),
}

/// A class's members under a UTF-8 locale: the Unicode 16.0 tables
/// scripts/gen_unicode_classes.py draws from Unicode's properties as the
/// C.UTF-8 locale does.
fn unicode_class(class: Class) -> &'static ClassUnicode {
    static TABLES: [OnceLock<ClassUnicode>; 12] = [const { OnceLock::new() }; 12];
    let (index, table) = match class {
        Class::Alnum => (0, classes::ALNUM),
        Class::Alpha => (1, classes::ALPHA),
        Class::Blank => (2, classes::BLANK),
        Class::Cntrl => (3, classes::CNTRL),
        Class::Digit => (4, classes::DIGIT),
        Class::Graph => (5, classes::GRAPH),
        Class::Lower => (6, classes::LOWER),
        Class::Print => (7, classes::PRINT),
        Class::Punct => (8, classes::PUNCT),
        Class::Space => (9, classes::SPACE),
        Class::Upper => (10, classes::UPPER),
        Class::Xdigit => (11, classes::XDIGIT),
    };
    TABLES[index].get_or_init(|| {
        ClassUnicode::new(table.iter().filter_map(|&(low, high)| {
            Some(ClassUnicodeRange::new(
                char::from_u32(low)?,
                char::from_u32(high)?,
            ))
        }))
    })
}

/// `[[:alnum:]_]`, the characters a word is made of.
pub(crate) fn word_char(c: char) -> bool {
    c == '_' || c.is_ascii_alphanumeric() || (!c.is_ascii() && has(unicode_class(Class::Alnum), c))
}

fn has(class: &ClassUnicode, c: char) -> bool {
    class
        .ranges()
        .binary_search_by(|range| {
            if range.end() < c {
                std::cmp::Ordering::Less
            } else if range.start() > c {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

fn byte(n: u32) -> u8 {
    u8::try_from(n.min(0xFF)).unwrap_or(0xFF)
}

impl Members {
    /// Every unit: `.`.
    pub(crate) fn any(utf8: bool) -> Members {
        if utf8 {
            Members::Chars(ClassUnicode::new([ClassUnicodeRange::new('\0', char::MAX)]))
        } else {
            Members::Bytes(ClassBytes::new([ClassBytesRange::new(0, 0xFF)]))
        }
    }

    /// One unit, matched in either case.
    pub(crate) fn folded(unit: Unit, utf8: bool) -> Members {
        let mut members = match unit {
            Unit::Char(c) if utf8 => {
                Members::Chars(ClassUnicode::new([ClassUnicodeRange::new(c, c)]))
            }
            unit => {
                let b = byte(unit.ordinal());
                Members::Bytes(ClassBytes::new([ClassBytesRange::new(b, b)]))
            }
        };
        members.fold();
        members
    }

    /// A bracket expression or its escape, folded under `ignore_case`
    /// before it is negated.
    pub(crate) fn of(set: &Set, utf8: bool, ignore_case: bool) -> Members {
        let mut members = if utf8 {
            let mut class = ClassUnicode::empty();
            for item in &set.items {
                match *item {
                    Item::Unit(Unit::Char(c)) => {
                        class.push(ClassUnicodeRange::new(c, c));
                    }
                    Item::Unit(Unit::Byte(_)) => {}
                    Item::Range(low, high) => {
                        if let (Some(low), Some(high)) = (
                            char::from_u32(low.ordinal()),
                            char::from_u32(high.ordinal()),
                        ) {
                            class.push(ClassUnicodeRange::new(low, high));
                        }
                    }
                    Item::Class(name) => class.union(unicode_class(name)),
                }
            }
            Members::Chars(class)
        } else {
            let mut class = ClassBytes::empty();
            for item in &set.items {
                match *item {
                    Item::Unit(unit) => {
                        let b = byte(unit.ordinal());
                        class.push(ClassBytesRange::new(b, b));
                    }
                    Item::Range(low, high) => {
                        if low.ordinal() <= 0xFF {
                            class.push(ClassBytesRange::new(
                                byte(low.ordinal()),
                                byte(high.ordinal()),
                            ));
                        }
                    }
                    Item::Class(name) => {
                        for &(low, high) in name.ranges() {
                            class.push(ClassBytesRange::new(low, high));
                        }
                    }
                }
            }
            Members::Bytes(class)
        };
        if ignore_case {
            members.fold();
        }
        if set.negated {
            members.negate();
        }
        members
    }

    /// Add the other case of every letter: ASCII's for bytes, Unicode's
    /// simple folding for characters.
    fn fold(&mut self) {
        match self {
            Members::Bytes(class) => class.case_fold_simple(),
            Members::Chars(class) => class.case_fold_simple(),
        }
    }

    fn negate(&mut self) {
        match self {
            Members::Bytes(class) => class.negate(),
            Members::Chars(class) => class.negate(),
        }
    }

    /// Leave out one byte: a record's terminator, or the newline under
    /// multi-line matching.
    pub(crate) fn without(&mut self, b: u8) {
        match self {
            Members::Bytes(class) => {
                class.difference(&ClassBytes::new([ClassBytesRange::new(b, b)]))
            }
            Members::Chars(class) => {
                let c = char::from(b);
                class.difference(&ClassUnicode::new([ClassUnicodeRange::new(c, c)]));
            }
        }
    }

    pub(crate) fn contains(&self, unit: Unit) -> bool {
        match (self, unit) {
            (Members::Bytes(class), unit) => {
                let b = byte(unit.ordinal());
                class
                    .ranges()
                    .iter()
                    .any(|range| range.start() <= b && b <= range.end())
            }
            (Members::Chars(class), Unit::Char(c)) => has(class, c),
            (Members::Chars(_), Unit::Byte(_)) => false,
        }
    }

    pub(crate) fn hir(&self) -> Hir {
        match self {
            Members::Bytes(class) => Hir::class(HirClass::Bytes(class.clone())),
            Members::Chars(class) => Hir::class(HirClass::Unicode(class.clone())),
        }
    }
}

/// Whether two characters are one letter in different cases, by Unicode's
/// simple case folding.
pub(crate) fn same_letter(a: char, b: char) -> bool {
    if a == b {
        return true;
    }
    let mut class = ClassUnicode::new([ClassUnicodeRange::new(a, a)]);
    class.case_fold_simple();
    has(&class, b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_classes_draw_as_the_c_utf8_locale_does() {
        let is = |class, c: char| has(unicode_class(class), c);
        // The no-break spaces are no space or blank, and NEL is no space.
        for c in ['\u{A0}', '\u{2007}', '\u{202F}'] {
            assert!(!is(Class::Space, c) && !is(Class::Blank, c) && is(Class::Graph, c));
        }
        assert!(!is(Class::Space, '\u{85}') && is(Class::Space, '\u{3000}'));
        assert!(is(Class::Cntrl, '\u{2028}') && is(Class::Cntrl, '\u{2029}'));
        // Format and private use characters print.
        assert!(is(Class::Print, '\u{200D}') && is(Class::Punct, '\u{E000}'));
        // Other scripts' digits are letters; ASCII digits are not.
        assert!(is(Class::Alpha, '\u{660}') && !is(Class::Alpha, '7'));
        // A titlecase letter is upper, and the Latin ones lower too.
        assert!(is(Class::Upper, '\u{1C5}') && is(Class::Lower, '\u{1C5}'));
        assert!(is(Class::Upper, '\u{1F88}') && !is(Class::Lower, '\u{1F88}'));
    }

    fn set(negated: bool, items: Vec<Item>) -> Set {
        Set {
            negated,
            items,
            bracket: true,
        }
    }

    #[test]
    fn classes_are_unicode_under_utf8() {
        let alpha = Members::of(&set(false, vec![Item::Class(Class::Alpha)]), true, false);
        assert!(alpha.contains(Unit::Char('é')));
        assert!(!alpha.contains(Unit::Char('1')));
        let alpha = Members::of(&set(false, vec![Item::Class(Class::Alpha)]), false, false);
        assert!(!alpha.contains(Unit::Byte(0xE9)));
        let upper = Members::of(&set(false, vec![Item::Class(Class::Upper)]), true, true);
        assert!(upper.contains(Unit::Char('é')));
    }

    #[test]
    fn a_negated_set_matches_no_stray_byte() {
        let none = Members::of(&set(true, vec![Item::Unit(Unit::Char('a'))]), true, false);
        assert!(none.contains(Unit::Char('b')));
        assert!(!none.contains(Unit::Byte(0xFF)));
    }

    #[test]
    fn letters_fold_by_unicode() {
        assert!(same_letter('é', 'É'));
        assert!(same_letter('σ', 'Σ'));
        assert!(!same_letter('a', 'b'));
        assert!(word_char('é'));
        assert!(!word_char('-'));
    }
}
