# Built-in porn-site list

`build.py` makes `extension/rules/adult.json` (and `adult-count.json`).

1. Downloads two public lists: the Block List Project porn list (public
   domain) and Steven Black's porn-only hosts (MIT).
2. Drops invalid names.
3. Drops public suffixes (shared hosting and DNS names such as `dynu.net` or
   `de.vu`). Blocking one of those would block thousands of unrelated sites;
   specific sites under them stay listed.
4. Drops the names in `exclude.txt`: sites whose main purpose is not porn
   (newspapers, shops, search engines, image hosts, mainstream dating apps,
   ...). They were found by checking the list against the 30,000 most-visited
   sites (Tranco) and reviewing every hit without an obviously adult name.
5. Refuses to build if a well-known site (Google, YouTube, X, Reddit,
   Wikipedia, ...) would be blocked.

Run `python build.py --check-top top-1m.csv` with a Tranco list to see how
many of the top 30,000 sites are blocked.

Found a site that is blocked by mistake, or a porn site that isn't? Open an
issue.
