use anchor_lang_idl::build::IdlBuilder;
use std::{env, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        env::args()
            .nth(1)
            .ok_or("Expected absolute program workspace path")?,
    );
    let program = env::args().nth(2).unwrap_or_else(|| "cox".to_owned());
    if program.is_empty() || !program.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Invalid program directory name".into());
    }
    let idl = IdlBuilder::new()
        .program_path(root.join("programs").join(&program))
        .no_docs(true)
        .resolution(true)
        .skip_lint(true)
        .build()?;
    fs::create_dir_all(root.join("idl"))?;
    fs::write(
        root.join("idl").join(format!("{program}.json")),
        format!("{}\n", serde_json::to_string_pretty(&idl)?),
    )?;
    Ok(())
}
