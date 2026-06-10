# Bee Commands: Create Job By Email Trigger Case

Replace `<EMAIL_TO>` with your test recipient email.

## 1) Keyword match (email expected)

```bash
bee job create freestyle mail-done-keyword-3m \
  --description "email keyword Done match" \
  --shell "csh scripts/csh/done_keyword.csh Done" \
  --email "<EMAIL_TO>" \
  --email-cond always \
  --email-keyword "Done"
```

## 2) Regex match (email expected)

```bash
bee job create freestyle mail-failed-regex-3m \
  --description "email regex Failed match" \
  --shell "csh scripts/csh/failed_regex.csh" \
  --email "<EMAIL_TO>" \
  --email-cond always \
  --email-regex "Failed"
```

## 3) No match (email not expected)

```bash
bee job create freestyle mail-nomatch-3m \
  --description "email no match" \
  --shell "csh scripts/csh/no_match.csh" \
  --email "<EMAIL_TO>" \
  --email-cond always \
  --email-keyword "Done" \
  --email-regex "Done|Failed"
```

## 4) Clear filter / condition-only (`email-cond` driven)

```bash
bee job create freestyle mail-clearfilter-3m \
  --description "email cond only" \
  --shell "csh scripts/csh/done_failed.csh" \
  --email "<EMAIL_TO>" \
  --email-cond always
```
