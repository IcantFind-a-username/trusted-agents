# SC6131 Capstone Final Report — LaTeX source

Final report for NTU SC6131 (MSBT, November 2025 intake), individual submission by
Yiqun Xu (Franz), G2509092H. Industry partner: Taiko. Teammate: Zhang Hanyu.

The report documents the paid-attention layer implemented on the branch
`feat/phase1-notification-coalescing` ([PR #1](https://github.com/IcantFind-a-username/trusted-agents/pull/1))
and reproduces the teammate's evaluation from `evaluation/results.md` ([PR #2](https://github.com/IcantFind-a-username/trusted-agents/pull/2)).

## Layout

```
main.tex                 document shell, packages, metadata macros
sections/
  00-titlepage.tex       title page with the fixed submission facts
  01-abstract.tex
  02-introduction.tex
  03-background.tex      TAP, Taiko/Tack/x402, related work
  04-requirements.tex    FR/NFR list and threat model
  05-design.tex          design pivot, principles, each mechanism (TikZ figures)
  06-implementation.tex
  07-evaluation.tex      teammate's results, reproduced verbatim
  08-discussion.tex      security table, limitations
  09-project-management.tex
  10-conclusion.tex
  11-references.tex      thebibliography (no BibTeX step needed)
  12-appendix.tex        config, notification block examples, commit log
SC6131-Final-Report.pdf  compiled output (regenerate with the commands below)
```

## Build

Requires a TeX Live installation with `latexmk` (or plain `pdflatex`). No external
bibliography tool is needed.

```bash
cd docs/sc6131-final-report
latexmk -pdf -interaction=nonstopmode main.tex
# or
pdflatex main && pdflatex main && pdflatex main
cp main.pdf SC6131-Final-Report.pdf
```

Three passes are needed for the table of contents and cross-references to settle.

## Editing conventions

- Fixed facts (name, matriculation number, mentor, deadline, URLs) are macros at the top of
  `main.tex`; change them there only.
- All numbers in Section 7 (Evaluation) come from `evaluation/results.md` and must not be
  edited independently of that file.
- Inline code uses `\code{...}`; listings use `lstlisting` with the `json`, `yaml` or `bash`
  language.
