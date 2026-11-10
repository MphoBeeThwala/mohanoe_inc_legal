# South African Legal AI RAG Engine: Data Source & Context Specification

Executive Summary

This document specifies the authoritative, industry-acceptable South African legal sources required to build a Retrieval-Augmented Generation (RAG) context engine for legal practice management software. The engine supports features including legal research, document drafting, and client intake case evaluations.

1. Primary Sources of Law (High Authority)

1.1 Judicial Precedents & Case Law

SAFLII (Southern African Legal Information Institute)

Scope: Open-access collection of Constitutional Court, Supreme Court of Appeal (SCA), High Courts, Labour Courts, Land Claims Court, Tax Courts, and major administrative tribunals.

Access Model: Open Access / Public API / Scraping guidelines.

LexisNexis South Africa (Law Reports)

Scope: South African Law Reports (SALR), All South African Law Reports (All SA), specialized reports (Labour Law Reports, Tax Cases).

Access Model: Proprietary / Commercial API Licensing Required.

JutaLaw / Juta

Scope: Juta’s Unreported & Reported Judgments, specialized law reports.

Access Model: Proprietary / Commercial Data License.

1.2 Statutory & Regulatory Frameworks

Laws.africa / Open Bylaws

Scope: Machine-readable, consolidated Acts, Amendment Acts, and Municipal By-laws across all 9 provinces.

Access Model: Open API / Akoma Ntoso XML Standard format.

Government & Provincial Gazettes

Scope: Acts, Bills, Regulations, Proclamations, Board Notices, and Departmental Notices.

Access Model: Official Government Portals / Sabinet Discover (Commercial Index).

Sabinet NetLaw

Scope: Consolidated, updated South African primary legislation and regulations.

Access Model: Commercial API / Data Access.

2. Procedural Rules & Court Practice Guidelines

Uniform Rules of Court (Superior Courts Act 10 of 2013)

High Court rules governing pleadings, motion procedure, discovery, and execution.

Magistrates' Courts Rules & Act 32 of 1944

Lower court civil procedure rules and jurisdictional rules.

Constitutional Court & Supreme Court of Appeal Rules

Appeals and direct access procedures.

Divisional Practice Directives

Specific directives issued by Judge Presidents (e.g., Gauteng Division, Western Cape Division) governing court rolls, case management, and urgent applications.

Legal Practice Council (LPC) Code of Conduct

Rules of professional conduct, ethics, legal billing, and trust account compliance (e.g., LPC Rule 54).

3. Specialized Dispute Bodies & Tribunals (Intake & Case Evaluation)

CCMA & Bargaining Councils

Arbitration awards, CCMA practice guidelines, and sector-specific bargaining council agreements (Essential for Labour & Employment intake).

Competition Authorities

Rulings and decisions of the Competition Commission, Competition Tribunal, and Competition Appeal Court.

Regulatory Ombuds & National Consumer Tribunal

Decisions from the FAIS Ombud, Ombudsman for Banking Services, CGSO (Consumer Goods and Services Ombud), and National Consumer Tribunal (NCT).

SARS Tax Appeals & Rulings

Tax Court judgments, SARS Binding Private Rulings (BPR), and Binding General Rulings (BGR).

4. Secondary Sources & Academic Literature

Sabinet African Journals

Peer-reviewed journals including South African Law Journal (SALJ), De Jure, PER / PELJ, and THRHR.

De Rebus

Official journal of the South African legal profession.

Advocate Magazine

Official journal of the General Council of the Bar of South Africa.

Standard Academic & Practice Treatises (Commercial Licensing Required)

Erasmus: Superior Court Practice

Henochsberg on the Companies Act 71 of 2008

Silke on South African Income Tax

Bill of Rights Compendium

5. Regulatory Compliance & Intake Verification

FIC (Financial Intelligence Centre)

Directives, Guidance Notes, Public Compliance Notices, and Sanctions Lists (Mandatory for automated FICA intake validation).

Information Regulator (South Africa)

POPIA & PAIA guidance notes, codes of conduct, and enforcement notices.

CIPC (Companies and Intellectual Property Commission)

Practice notes, circulars, corporate registry datasets for intake verification.

Technical Architectural Requirements for Agentic RAG

┌─────────────────────────────────────────────────────────────┐
│                    User Prompt / Task                       │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│               Legal Query Intent Parser                      │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│              Hierarchy of Precedence Filter                 │
├─────────────────────────────────────────────────────────────┤
│ Level 1: Constitutional Court Judgments                     │
│ Level 2: Supreme Court of Appeal (SCA) Judgments            │
│ Level 3: Full Bench / Single Judge High Court Judgments      │
│ Level 4: Consolidated Statutes & Regulations                │
│ Level 5: Procedural Rules & Practice Directives             │
│ Level 6: Secondary Academic Literature & Commentary         │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│              Temporal Validity Validation                   │
│   (Check active date of statute; flag repealed provisions)  │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│              LLM Context Injection & Generation              │
└─────────────────────────────────────────────────────────────┘


Hierarchy of Authority Routing: Vector indexing must weight results based on binding precedent rules (e.g., Constitutional Court > SCA > Provincial High Court).

Temporal Metadata Tagging: Every statute chunk must include effective_date, amendment_status, and repealed_date metadata to prevent hallucinating obsolete law.

Citation Formatting Standard: LLM generation should be constrained to output standard South African legal citation formats (e.g., [Year] ZACC [Number], [Year] ZASCA [Number], or SALR references).