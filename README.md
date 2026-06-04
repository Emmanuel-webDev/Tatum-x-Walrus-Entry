# VAULT.SUI

## Privacy-Preserving Document Storage on Walrus

### The Problem

Today, storing sensitive files online means trusting a third party.

Whether it is cloud drives, messaging apps, or traditional storage providers, users are forced to upload documents to servers where providers often control:

- Storage infrastructure
- Access permissions
- Data retention
- Recovery processes

Even when files are encrypted, users rarely own the encryption keys.

For individuals storing legal records, certificates, financial statements, research documents, or confidential business files, this creates a fundamental trust problem:

> Who truly controls the data?

---

## Our Solution

VAULT.SUI is a decentralized encrypted document vault built on Sui and Walrus.

Every file is encrypted locally in the user's browser before leaving their device.

The encrypted file is then stored on Walrus while ownership and metadata are registered on Sui.

At no point does VAULT.SUI gain access to the plaintext contents of a document.

### Core Principle

> If we cannot decrypt your files, we cannot leak them.

---

## How It Works

### Step 1 — Connect Wallet

Users connect a Sui-compatible wallet.

A personal vault registry is associated with their wallet address.

### Step 2 — Encrypt Locally

Before upload:

- AES-GCM encryption is performed in-browser
- A unique encryption key is generated
- A unique IV is generated

The plaintext file never leaves the device.

### Step 3 — Store on Walrus

The encrypted bytes are uploaded to Walrus.

Walrus provides:

- Decentralized blob storage
- Epoch-based storage allocation
- Content-addressed retrieval
- High availability through distributed storage nodes

The upload returns:

- Blob ID
- Storage expiration epoch

### Step 4 — Register Metadata on Sui

Only metadata is stored on-chain:

- Blob ID
- Filename
- MIME type
- File size
- Upload timestamp
- Expiration epoch

The encrypted file itself never touches the blockchain.

### Step 5 — Secure Retrieval

To retrieve a file:

- Blob is downloaded from Walrus
- Decryption occurs locally
- Original file is reconstructed in-browser

The encryption key never leaves user control.

---

## Secure Sharing

VAULT.SUI introduces a simple sharing model.

Users can generate a secure retrieval link containing:

- Blob ID
- IV
- Encryption key

Recipients can decrypt the document without requiring:

- A VAULT.SUI account
- Wallet ownership
- Access to the original uploader

This creates a lightweight, privacy-preserving sharing workflow.

---

## Epoch Monitoring

Walrus storage is epoch-based.

Most users have no visibility into:

- Current storage status
- Remaining storage duration
- Upcoming expiration

VAULT.SUI solves this by displaying:

- Expiration warning of the duration of an upload 

This makes decentralized storage easier to understand and manage.

---

## Storage Renewal

Files should not disappear simply because users forget about storage expiration.

VAULT.SUI plans to introduces renewable storage in the future.

Users can:

- View expiration status
- Receive expiration warnings
- Extend storage duration
- Maintain long-term availability

Renewal is performed through Walrus storage extension transactions.

---

## Security Model

### What VAULT.SUI Can See

- Blob IDs
- File names
- File size
- Upload timestamps

### What VAULT.SUI Cannot See

- Document contents
- Encryption keys
- User plaintext data

### Encryption

VAULT.SUI  uses:

- AES-256-GCM
- Unique per-file encryption keys
- Unique initialization vectors

All cryptographic operations occur client-side.

---

## Why Walrus

Walrus is uniquely positioned for decentralized storage because it combines:

- Efficient blob storage
- Native Sui integration
- Epoch-based storage economics
- On-chain verifiability

VaultLock leverages Walrus to provide secure document storage without sacrificing usability.

---

## Use Cases

### Personal Document Vault

Store:

- Passports
- Certificates
- Academic records
- Tax documents

### Research Preservation

Protect:

- Research papers
- Datasets
- Draft publications

### Business Records

Store:

- Contracts
- Invoices
- Internal documents

### Secure Sharing

Distribute sensitive documents without exposing them to centralized providers.

---

## Technology Stack

### Frontend

- HTML
- CSS
- JavaScript
- Vite

### Blockchain

- MOVE
- Sui network 

### Storage

- Walrus

### Cryptography

- Web Crypto API
- AES-GCM

### Wallet Integration

- Sui Wallet Compatible

---

## Key Features

- Client-side encryption before upload
- Decentralized storage via Walrus
- Ownership and metadata management on Sui
- Secure shareable retrieval links
- Epoch expiration tracking
- Renewable storage duration in coming future 
- Browser-based decryption
- No backend access to plaintext documents

---

## Vision

VAULT.SUI  aims to become the secure personal data layer for the decentralized web.

Instead of trusting platforms with sensitive information, users retain full ownership of:

- Their files
- Their encryption keys
- Their storage lifecycle

By combining local encryption, Walrus storage, and Sui ownership, VAULT.SUI  delivers a future where privacy is the default rather than a feature.
