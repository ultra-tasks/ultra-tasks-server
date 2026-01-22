# Records of Processing Activities (Article 30 GDPR)

**Organization:** Super Productivity Sync
**Data Controller:** Johannes Millan
**Date:** 2026-01-22
**Last Review:** 2026-01-22
**Next Review:** 2027-01-22

---

## Purpose

This document fulfills the requirement of GDPR Article 30 to maintain records of data processing activities. It documents all personal data processing performed by Super Productivity Sync.

---

## Controller Information

**Name:** Johannes Millan
**Role:** Individual Data Controller
**Location:** Germany
**Contact:** contact@super-productivity.com
**Website:** https://super-productivity.com

**Data Protection Officer (DPO):** Not required

- Processing does not meet Art. 37 thresholds
- Not a public authority
- No regular/systematic large-scale monitoring
- Fewer than 20 employees in data processing roles

---

## Processing Activity #1: User Account Management

### Name of Processing Activity

User Account Management and Authentication

### Purposes of Processing

- Create and manage user accounts
- Authenticate users accessing the sync service
- Prevent unauthorized access
- Recover access for legitimate users

### Categories of Data Subjects

- Registered users of Super Productivity Sync
- Prospective users during registration

### Categories of Personal Data

| Data Category           | Examples                                                                  | Required/Optional      |
| ----------------------- | ------------------------------------------------------------------------- | ---------------------- |
| **Identity Data**       | Email address                                                             | Required               |
| **Authentication Data** | Password hash (bcrypt), passkey credentials                               | Required               |
| **Account Status**      | Verification status, active/inactive, registration date                   | Required               |
| **Security Data**       | Failed login attempts, account lockout status, token version              | Required               |
| **Recovery Data**       | Password reset tokens, email verification tokens, passkey recovery tokens | Optional (when needed) |
| **Terms Acceptance**    | Terms acceptance timestamp (`termsAcceptedAt`)                            | Required               |

### Categories of Recipients

| Recipient                         | Purpose                                                 | Location |
| --------------------------------- | ------------------------------------------------------- | -------- |
| Alfahosting GmbH                  | Hosting and infrastructure provider (Art. 28 processor) | Germany  |
| Data Controller (Johannes Millan) | Service operation and support                           | Germany  |

**No third-party recipients.** Data is not shared with analytics, advertising, or other external services.

### International Data Transfers

**None.** All data remains in Germany (Alfahosting GmbH data centers).

### Retention Periods

| Data Type             | Retention Period                                  | Justification                               |
| --------------------- | ------------------------------------------------- | ------------------------------------------- |
| Active accounts       | Until account deletion                            | Art. 6(1)(b) - Contract performance         |
| Inactive accounts     | 12 months after last activity, then deleted       | Data minimization, notified before deletion |
| Verification tokens   | Until used or expired (typically 24 hours)        | Security, one-time use                      |
| Password reset tokens | Until used or expired (typically 1 hour)          | Security, one-time use                      |
| Failed login logs     | Cleared after lockout expires or successful login | Security monitoring                         |

### Technical and Organizational Security Measures

- **Encryption in transit:** HTTPS/TLS for all communications
- **Password security:** bcrypt hashing (12 rounds), no plaintext storage
- **Authentication:** JWT tokens with expiry (7 days), token versioning for revocation
- **Passkey support:** WebAuthn/FIDO2 implementation
- **Rate limiting:** 100 requests per 15 minutes, account lockout after failed attempts
- **Email verification:** Required before account activation
- **Security headers:** Helmet.js (CSP, HSTS, X-Frame-Options, etc.)
- **Database security:** PostgreSQL with Prisma ORM (SQL injection prevention)
- **Access control:** Least privilege principle, token-based authentication
- **Monitoring:** Server logs, health checks

---

## Processing Activity #2: Data Synchronization

### Name of Processing Activity

Personal Productivity Data Synchronization Across Devices

### Purposes of Processing

- Synchronize user's productivity data across multiple devices
- Maintain data consistency and conflict resolution
- Enable offline work with eventual synchronization
- Provide data redundancy and backup

### Categories of Data Subjects

- Active users of Super Productivity Sync who have enabled synchronization

### Categories of Personal Data

| Data Category          | Examples                                                                   | Encryption Status               |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------- |
| **User Content**       | Tasks, projects, notes, time tracking entries, settings                    | Optional E2EE available         |
| **Sync Operations**    | Operation logs (actions, timestamps, vector clocks)                        | Optional E2EE available         |
| **Snapshots**          | Periodic full-state snapshots for faster sync                              | Optional E2EE available         |
| **Device Information** | Device ID (client-generated), device name, user agent, last seen timestamp | Plaintext (technical necessity) |
| **Sync State**         | Last sequence number, vector clock, last snapshot timestamp                | Plaintext (technical necessity) |

**End-to-End Encryption (E2EE):**

- Optional feature users can enable
- User content and operations encrypted client-side with user-provided key
- Server cannot decrypt E2EE data (zero-knowledge architecture)
- Key management: Client-side only, server never has access to encryption key

### Categories of Recipients

| Recipient                         | Purpose                                                        | Location |
| --------------------------------- | -------------------------------------------------------------- | -------- |
| Alfahosting GmbH                  | Hosting and infrastructure provider (Art. 28 processor)        | Germany  |
| Data Controller (Johannes Millan) | Service operation, debugging, support (E2EE data inaccessible) | Germany  |

**No third-party recipients.** No analytics, tracking, or external data sharing.

### International Data Transfers

**None.** All data remains in Germany.

### Retention Periods

| Data Type       | Retention Period                                    | Justification                           |
| --------------- | --------------------------------------------------- | --------------------------------------- |
| Sync operations | 45 days after being covered by snapshot             | Data minimization, technical efficiency |
| Snapshots       | Latest snapshot only, replaced on each new snapshot | Technical necessity for sync            |
| Device records  | Until last seen > 45 days (stale device cleanup)    | Data minimization                       |
| User content    | Until user deletes or account deleted               | Art. 6(1)(b) - Contract performance     |

**Account Deletion:** All sync data deleted immediately upon account deletion (hard delete with cascading).

### Technical and Organizational Security Measures

**In Transit:**

- HTTPS/TLS encryption for all API calls
- JWT authentication required for all sync operations
- Content-Encoding support (gzip compression)

**At Rest:**

- Optional end-to-end encryption (E2EE) with client-side key management
- Password-protected encryption keys (user chooses encryption password)
- [To verify: Database encryption at rest via Alfahosting]

**Data Integrity:**

- Vector clocks for conflict resolution
- Schema versioning for compatibility
- Payload validation (Zod schemas)
- Zip bomb protection

**Access Control:**

- User can only access their own data (server validates userId in JWT)
- Per-device client IDs for granular sync tracking
- Rate limiting: 100 uploads per minute, 200 downloads per minute

**Operational Security:**

- Automated daily cleanup jobs (old operations, stale devices)
- Storage quota enforcement (100MB default per user)
- Server-side request deduplication
- Health monitoring and logging

---

## Processing Activity #3: Server Logs and Security Monitoring

### Name of Processing Activity

Server Logs, Error Tracking, and Security Monitoring

### Purposes of Processing

- **Legitimate Interest (Art. 6(1)(f)):**
  - Detect and respond to security incidents
  - Prevent abuse and unauthorized access
  - Debug technical issues affecting service availability
  - Monitor service health and performance

### Categories of Data Subjects

- All users accessing the Super Productivity Sync server

### Categories of Personal Data

| Data Category           | Examples                                                    | Necessity           |
| ----------------------- | ----------------------------------------------------------- | ------------------- |
| **Network Data**        | IP address, timestamp, HTTP method, endpoint accessed       | Technical necessity |
| **Technical Data**      | User agent, browser type, OS, app version                   | Debugging           |
| **Error Data**          | Error messages, stack traces (sanitized), failed operations | Service reliability |
| **Authentication Data** | Failed login attempts, rate limit violations                | Security monitoring |

**Note:** Logs are minimized to exclude unnecessary personal data (no request bodies logged, no user content in logs).

### Categories of Recipients

| Recipient                         | Purpose                                                       | Location |
| --------------------------------- | ------------------------------------------------------------- | -------- |
| Alfahosting GmbH                  | Server infrastructure provider (logs stored on their servers) | Germany  |
| Data Controller (Johannes Millan) | Security monitoring, debugging, incident response             | Germany  |

### International Data Transfers

**None.** Log data remains in Germany.

### Retention Periods

| Log Type            | Retention Period                   | Justification                                     |
| ------------------- | ---------------------------------- | ------------------------------------------------- |
| Server access logs  | 7-14 days                          | Short-term security monitoring, then auto-deleted |
| Error logs          | 7-14 days                          | Debugging, then auto-deleted                      |
| Security event logs | [To implement: 1 year recommended] | Evidence preservation for incidents               |

### Technical and Organizational Security Measures

- **Access control:** Only authorized personnel can access logs
- **Log rotation:** Automated deletion after retention period
- **Sanitization:** Personal data minimized in logs (no passwords, tokens, or user content logged)
- **Secure storage:** Logs stored on secure servers (Alfahosting infrastructure)

---

## Processing Activity #4: Email Communications

### Name of Processing Activity

Transactional Email Communications

### Purposes of Processing

- Send account verification emails (Art. 6(1)(b) - Contract pre-requisite)
- Send password reset emails (Art. 6(1)(b) - Contract performance)
- Send magic link login emails (Art. 6(1)(b) - Contract performance)
- Send passkey recovery emails (Art. 6(1)(b) - Contract performance)
- Send inactive account deletion warnings (Art. 6(1)(f) - Legitimate interest + data minimization)

**No marketing emails.** All emails are transactional and necessary for service operation.

### Categories of Data Subjects

- Registered users
- Prospective users during registration

### Categories of Personal Data

| Data Category       | Content                         | Purpose                            |
| ------------------- | ------------------------------- | ---------------------------------- |
| **Email Address**   | Recipient email                 | Delivery of transactional messages |
| **One-Time Tokens** | Verification/reset/login tokens | Secure authentication              |
| **Timestamps**      | Email sent time, token expiry   | Security, prevent replay attacks   |

### Categories of Recipients

| Recipient                   | Purpose                                            | Location                |
| --------------------------- | -------------------------------------------------- | ----------------------- |
| Alfahosting GmbH (SMTP)     | Email delivery (Art. 28 processor, covered by AVV) | Germany                 |
| Email provider of recipient | Email delivery (e.g., Gmail, Outlook)              | Various (user's choice) |

**Note:** Email content contains only necessary information (tokens, expiry times). No user productivity data included in emails.

### International Data Transfers

- **Sending:** No transfers (Alfahosting SMTP servers in Germany)
- **Receiving:** Dependent on user's email provider (e.g., Gmail = USA)
  - This is user's choice of email provider, not data controller's transfer
  - User provides email during registration, implicitly consenting to their email provider's processing

### Retention Periods

| Data Type                   | Retention Period                   | Justification            |
| --------------------------- | ---------------------------------- | ------------------------ |
| Email sending logs          | 7-14 days (server logs)            | Debugging email delivery |
| One-time tokens in database | Until used or expired (1-24 hours) | Security                 |

**Note:** We do not retain copies of sent email content beyond server log retention.

### Technical and Organizational Security Measures

- **Encryption in transit:** TLS for SMTP connection (enforced)
- **Token security:** Cryptographically random, single-use, time-limited
- **Rate limiting:** Email verification resend limited to prevent abuse
- **Content minimization:** Emails contain only necessary information

---

## Processing Activity #5: Payment and Billing (Future)

**Status:** NOT YET IMPLEMENTED

**Note:** If paid subscription tiers are introduced, this section must be updated with:

- Payment processing details
- Billing information retention (10 years per German tax law §147 AO)
- Payment processor information (Art. 28 processor agreement required)

---

## Recipient Processors (Article 28 GDPR)

### Alfahosting GmbH

**Service Provided:** Server hosting, database hosting, email delivery (SMTP)

**Data Processing Agreement (AVV):** ✅ Yes, in place

**Location:** Germany

**Security Measures:**

- ISO 27001 certified [To verify]
- Physical security of data centers
- Network security and monitoring
- Regular security updates
- [To verify: Encryption at rest]

**Subprocessors:** None (Alfahosting does not re-share data)

**Review Frequency:** Annual review of AVV compliance

---

## Legal Basis Summary

| Processing Activity                | Legal Basis                                       | Article      |
| ---------------------------------- | ------------------------------------------------- | ------------ |
| Account management                 | Contract performance (sync service)               | Art. 6(1)(b) |
| Data synchronization               | Contract performance                              | Art. 6(1)(b) |
| Server logs (security)             | Legitimate interests (security, abuse prevention) | Art. 6(1)(f) |
| Server logs (debugging)            | Legitimate interests (service reliability)        | Art. 6(1)(f) |
| Transactional emails               | Contract performance / Pre-contractual measures   | Art. 6(1)(b) |
| Inactive account deletion warnings | Legitimate interests + data minimization          | Art. 6(1)(f) |

**Balancing Test for Legitimate Interests:**

- **Security monitoring:** User benefits from secure service, minimal privacy impact (IP logs short retention)
- **Service debugging:** User benefits from reliable service, logs minimized and short retention
- **Inactive account warnings:** Protects user data from unintended loss, gives opportunity to retain account

---

## Data Subject Rights

Users can exercise the following rights by contacting: **contact@super-productivity.com**

| Right                          | Implementation                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------- |
| **Access (Art. 15)**           | User can export all sync data via app; support provides account info on request |
| **Rectification (Art. 16)**    | User can update data via app operations                                         |
| **Erasure (Art. 17)**          | User can delete account via app settings; CLI command available for support     |
| **Restriction (Art. 18)**      | User can disable sync; manual restriction via support                           |
| **Data Portability (Art. 20)** | User can export sync data in JSON format via app                                |
| **Object (Art. 21)**           | User can object to processing by disabling sync or contacting support           |

**Response SLA:** Within 1 month (see Data Subject Request Procedures document)

---

## Special Categories of Data (Article 9)

**Not Applicable.** Super Productivity Sync does not intentionally process special categories of personal data:

- ❌ Racial or ethnic origin
- ❌ Political opinions
- ❌ Religious or philosophical beliefs
- ❌ Trade union membership
- ❌ Genetic data
- ❌ Biometric data (for uniquely identifying)
- ❌ Health data
- ❌ Sex life or sexual orientation data

**User Responsibility:** Users may choose to store sensitive information in their tasks/notes. We recommend enabling E2EE for such data. Privacy policy advises against storing highly sensitive data.

---

## Data Protection Impact Assessment (DPIA)

**Status:** Screening conducted, full DPIA not required

**Justification:** See DPIA Screening Decision document

**Re-evaluation Trigger:** If processing significantly changes (e.g., adding AI analysis, large-scale behavioral profiling, biometric authentication)

---

## Changes to Processing Activities

**Process for Updates:**

1. Identify change in data processing (new feature, new data category, new recipient)
2. Assess GDPR impact (legal basis, data subject rights, security measures)
3. Update this Records of Processing Activities document
4. Update privacy policy if user-facing changes
5. Obtain consent if required (e.g., new optional feature)
6. Notify supervisory authority if significant change (e.g., new international transfer)

**Change History:**
| Date | Change | Reason | Updated By |
|------|--------|--------|------------|
| 2026-01-22 | Initial creation | GDPR compliance | AI Assistant |
| | | | |

---

## Review and Maintenance

**Review Frequency:** Annual (minimum) or when processing activities change

**Next Review Date:** 2027-01-22

**Responsible Person:** Data Controller (Johannes Millan)

**Review Checklist:**

- [ ] Processing activities still accurate
- [ ] New processing activities added
- [ ] Obsolete processing activities removed
- [ ] Retention periods still appropriate
- [ ] Security measures still adequate
- [ ] Recipient agreements (AVV) still valid
- [ ] Legal bases still applicable
- [ ] Privacy policy reflects current processing

---

## Approval

**Data Controller:** **\*\***\*\***\*\***\_**\*\***\*\***\*\*** Date: \***\*\_\_\_\*\***
_Johannes Millan_

**Next Review:** 2027-01-22

---

## Appendices

### Appendix A: Data Flow Diagram

```
[User's Device]
    ↓ (HTTPS/TLS, JWT Auth)
[Super Productivity Sync Server]
    ↓ (Prisma ORM)
[PostgreSQL Database @ Alfahosting]
    ↓ (AVV in place)
[Alfahosting Infrastructure - Germany]

Email Flow:
[Sync Server] → [Alfahosting SMTP - Germany] → [User's Email Provider]
```

**No international data transfers in data controller's control.**

### Appendix B: Data Retention Timeline

```
Account Registration
    ↓
[Active Account] → Sync operations stored for 45 days
    ↓              (covered by snapshots, then deleted)
    ↓
[12 months inactivity] → Warning email sent
    ↓
[No login after warning] → Account deleted (all data purged)

OR

[User deletes account] → Immediate deletion (hard delete, cascading)
```

### Appendix C: Security Incident Log

**Purpose:** Maintain records of all data breaches (even if no notification required)

**Location:** See Incident Response Playbook

**Retention:** 3-5 years

**Current Incidents:** None recorded as of 2026-01-22

---

_This document is confidential and for internal use. May be requested by supervisory authority during audits._
