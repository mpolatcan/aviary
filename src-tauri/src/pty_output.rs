pub struct PtyOutputNormalizer {
    carry: String,
}

impl Default for PtyOutputNormalizer {
    fn default() -> Self {
        Self::new()
    }
}

impl PtyOutputNormalizer {
    pub fn new() -> Self {
        Self {
            carry: String::new(),
        }
    }

    pub fn normalize(&mut self, chunk: &str) -> String {
        let mut input = String::new();
        input.push_str(&self.carry);
        input.push_str(chunk);
        self.carry.clear();

        let mut output = String::with_capacity(input.len());
        let mut iter = input.char_indices().peekable();

        while let Some((idx, ch)) = iter.next() {
            if ch == '\x1b' {
                match iter.peek().copied() {
                    None => {
                        self.carry.push_str(&input[idx..]);
                        break;
                    },
                    Some((_, '[')) => {
                        let _ = iter.next();
                        let params_start = idx + 2;
                        let mut final_at: Option<(usize, char)> = None;
                        for (pos, next) in iter.by_ref() {
                            if is_csi_final(next) {
                                final_at = Some((pos, next));
                                break;
                            }
                        }

                        let Some((final_pos, final_ch)) = final_at else {
                            self.carry.push_str(&input[idx..]);
                            break;
                        };

                        let params = &input[params_start..final_pos];
                        if final_ch == 'm' {
                            output.push_str(&self.update_sgr(params));
                        } else {
                            output.push_str(&input[idx..final_pos + final_ch.len_utf8()]);
                        }
                        continue;
                    },
                    _ => {},
                }
            }

            output.push(ch);
        }

        output
    }

    fn update_sgr(&mut self, params: &str) -> String {
        let parts: Vec<&str> = if params.is_empty() {
            vec!["0"]
        } else {
            params.split(';').collect()
        };
        let mut next: Vec<String> = Vec::with_capacity(parts.len());
        let mut changed = false;
        let mut i = 0;

        while i < parts.len() {
            let raw = if parts[i].is_empty() { "0" } else { parts[i] };
            if raw.contains(':') {
                next.push(parts[i].to_string());
                i += 1;
                continue;
            }

            let value = raw.parse::<u16>().ok();
            match value {
                Some(38) if parts.get(i + 1) == Some(&"5") && parts.get(i + 2).is_some() => {
                    next.push(raw.to_string());
                    next.push(parts[i + 1].to_string());
                    next.push(parts[i + 2].to_string());
                    i += 2;
                },
                Some(38)
                    if parts.get(i + 1) == Some(&"2")
                        && parts.get(i + 2).is_some()
                        && parts.get(i + 3).is_some()
                        && parts.get(i + 4).is_some() =>
                {
                    next.push(raw.to_string());
                    next.push(parts[i + 1].to_string());
                    next.push(parts[i + 2].to_string());
                    next.push(parts[i + 3].to_string());
                    next.push(parts[i + 4].to_string());
                    i += 4;
                },
                Some(48) if parts.get(i + 1) == Some(&"5") && parts.get(i + 2) == Some(&"16") => {
                    next.push("49".to_string());
                    changed = true;
                    i += 2;
                },
                Some(48) if parts.get(i + 1) == Some(&"5") && parts.get(i + 2).is_some() => {
                    next.push(raw.to_string());
                    next.push(parts[i + 1].to_string());
                    next.push(parts[i + 2].to_string());
                    i += 2;
                },
                Some(48)
                    if parts.get(i + 1) == Some(&"2")
                        && parts.get(i + 2).is_some()
                        && parts.get(i + 3).is_some()
                        && parts.get(i + 4).is_some() =>
                {
                    next.push(raw.to_string());
                    next.push(parts[i + 1].to_string());
                    next.push(parts[i + 2].to_string());
                    next.push(parts[i + 3].to_string());
                    next.push(parts[i + 4].to_string());
                    i += 4;
                },
                _ => next.push(raw.to_string()),
            }

            i += 1;
        }

        if changed {
            format!("\x1b[{}m", next.join(";"))
        } else {
            format!("\x1b[{params}m")
        }
    }
}

fn is_csi_final(ch: char) -> bool {
    matches!(ch, '\u{40}'..='\u{7e}')
}

#[cfg(test)]
mod tests {
    use super::PtyOutputNormalizer;

    #[test]
    fn rewrites_bg16_without_touching_block_elements() {
        let mut normalizer = PtyOutputNormalizer::new();
        let output = normalizer.normalize("\x1b[38;5;174m▛\x1b[48;5;16m█\x1b[49m\x1b[39m");
        assert!(output.contains('▛'));
        assert!(output.contains('█'));
        assert!(!output.contains("48;5;16"));
        assert!(output.contains("\x1b[49m"));
    }
}
