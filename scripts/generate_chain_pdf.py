#!/usr/bin/env python3
"""
Generate ONE long, fully connected synthetic chain of title as a single
searchable PDF, plus an answer key with the expected final ownership.

Every instrument covers the same tract and refers back to earlier recorded
instruments by volume/page (or instrument number). The chain runs from the
sovereign patent (1884) to a 2014 assignment of the producing lease. It
includes probates, heirship affidavits, a floating NPRI, a dead lease with an
ORRI that dies with it, a correction deed, a corporate merger, a trust
distribution, a judgment lien and its release, and a pooled unit.

Outputs (git-ignored):
  scripts/sample-docs/synthetic_chain_of_title.pdf
  scripts/sample-docs/synthetic_chain_of_title_key.md
  scripts/sample-docs/synthetic_chain_of_title_key.json

Requires: pip install reportlab
Run:      python3 scripts/generate_chain_pdf.py
"""
import json
import os
from fractions import Fraction as F

from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (BaseDocTemplate, CondPageBreak, Flowable,
                                Frame, KeepTogether, PageBreak, PageTemplate,
                                Paragraph, Spacer)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "sample-docs")
PDF_PATH = os.path.join(OUT, "synthetic_chain_of_title.pdf")

# ── the tract ────────────────────────────────────────────────────────────────
LEGAL = ("All of Section Fourteen (14), Block Fifty-Seven (57), Township Two (2), "
         "T&amp;P Ry. Co. Survey, Abstract No. 3318, Reeves County, Texas, "
         "containing 640 acres of land, more or less")
LEGAL_S = "Section 14, Block 57, Twp. 2, T&amp;P Ry. Co. Survey, A-3318, Reeves County, Texas"
LEGAL_WRONG = LEGAL.replace("Fourteen (14)", "Forty-One (41)")
SEC13 = ("All of Section Thirteen (13), Block Fifty-Seven (57), Township Two (2), "
         "T&amp;P Ry. Co. Survey, Abstract No. 3317, Reeves County, Texas, "
         "containing 640 acres of land, more or less")

# ── styles ───────────────────────────────────────────────────────────────────
S_TITLE = ParagraphStyle("t", fontName="Times-Bold", fontSize=14, leading=18,
                         alignment=TA_CENTER, spaceAfter=10)
S_SUB = ParagraphStyle("s", fontName="Times-Roman", fontSize=10.5, leading=13,
                       alignment=TA_CENTER, spaceAfter=10)
S_BODY = ParagraphStyle("b", fontName="Times-Roman", fontSize=11, leading=15,
                        alignment=TA_JUSTIFY, spaceAfter=8, firstLineIndent=28)
S_FLUSH = ParagraphStyle("f", parent=S_BODY, firstLineIndent=0)
S_SIG = ParagraphStyle("g", fontName="Times-Roman", fontSize=11, leading=14,
                       alignment=TA_LEFT, leftIndent=3.2 * inch, spaceAfter=10)
S_ACK = ParagraphStyle("a", fontName="Times-Roman", fontSize=9.5, leading=12.5,
                       alignment=TA_JUSTIFY, spaceAfter=6)
S_ACKH = ParagraphStyle("ah", parent=S_ACK, fontName="Times-Bold",
                        alignment=TA_LEFT, spaceBefore=8)
S_REC = ParagraphStyle("r", fontName="Courier", fontSize=8.5, leading=11,
                       alignment=TA_LEFT, spaceBefore=10, leftIndent=12,
                       borderColor="#555555", borderWidth=0.75, borderPadding=6)
S_COVER = ParagraphStyle("c", fontName="Times-Roman", fontSize=12, leading=17,
                         alignment=TA_CENTER)


# ── boilerplate helpers ──────────────────────────────────────────────────────
def P(text):
    return Paragraph(text, S_BODY)


def sig(*lines):
    return Paragraph("_______________________________<br/>" + "<br/>".join(lines), S_SIG)


def ack_couple(husband, wife, date, notary, county="Reeves", privy=True):
    """Pre-1967 Texas forms carry a separate privy examination of the wife."""
    out = [Paragraph(f"THE STATE OF TEXAS }}<br/>COUNTY OF {county.upper()} }}", S_ACKH),
           Paragraph(
               f"BEFORE ME, the undersigned authority, on this day personally appeared "
               f"{husband} and {wife}, his wife, both known to me to be the persons whose "
               f"names are subscribed to the foregoing instrument, and acknowledged to me that "
               f"they each executed the same for the purposes and consideration therein "
               f"expressed.", S_ACK)]
    if privy:
        out.append(Paragraph(
            f"And the said {wife}, wife of the said {husband}, having been examined by me "
            f"privily and apart from her husband, and having the same fully explained to her, "
            f"she, the said {wife}, acknowledged such instrument to be her act and deed, and "
            f"declared that she had willingly signed the same, and that she did not wish to "
            f"retract it.", S_ACK))
    out.append(Paragraph(
        f"GIVEN UNDER MY HAND AND SEAL OF OFFICE this {date}.<br/>"
        f"{notary}, Notary Public in and for {county} County, Texas", S_ACK))
    return out


def ack_one(name, date, notary, county="Reeves", capacity=""):
    cap = f", {capacity}," if capacity else ""
    return [Paragraph(f"THE STATE OF TEXAS }}<br/>COUNTY OF {county.upper()} }}", S_ACKH),
            Paragraph(
                f"This instrument was acknowledged before me on {date}, by {name}{cap} "
                f"for the purposes and consideration therein expressed.", S_ACK),
            Paragraph(f"{notary}, Notary Public, State of Texas", S_ACK)]


def ack_corp(officer, title, corp, date, notary, county="Reeves", state="TEXAS"):
    return [Paragraph(f"THE STATE OF {state} }}<br/>COUNTY OF {county.upper()} }}", S_ACKH),
            Paragraph(
                f"BEFORE ME, the undersigned authority, on this day personally appeared "
                f"{officer}, {title} of {corp}, known to me to be the person whose name is "
                f"subscribed to the foregoing instrument, and acknowledged to me that he "
                f"executed the same as the act and deed of said corporation, for the purposes "
                f"and consideration therein expressed, and in the capacity therein stated.",
                S_ACK),
            Paragraph(f"GIVEN UNDER MY HAND AND SEAL OF OFFICE this {date}.<br/>"
                      f"{notary}, Notary Public in and for {county} County, {state.title()}",
                      S_ACK)]


def rec(filed, recorded, ref, clerk, deputy=None):
    by = f"<br/>By: {deputy}, Deputy" if deputy else ""
    return Paragraph(
        f"FILED FOR RECORD {filed}<br/>RECORDED {recorded}<br/>{ref}<br/>"
        f"{clerk}, County Clerk, Reeves County, Texas{by}", S_REC)


# ── instruments ──────────────────────────────────────────────────────────────
# Each entry: ref (shown in the page header), title, subtitle, flowables.
# The "key" dict feeds the run sheet in the answer key.
INSTRUMENTS = []


def inst(ref, title, key, body, subtitle=None):
    INSTRUMENTS.append(dict(ref=ref, title=title, subtitle=subtitle, body=body, key=key))


# 1 ─ Patent
inst("Deed Records Vol. A, Page 12", "PATENT",
     dict(date="1884-06-20", rec="Vol. A, Pg. 12 (DR)", type="Patent",
          grantor="The State of Texas", grantee="Texas and Pacific Railway Company",
          interest="100% fee (surface and minerals)"),
     [P("THE STATE OF TEXAS. Patent No. 211, Volume 37. Abstract No. 3318."),
      P("KNOW ALL MEN BY THESE PRESENTS: That I, JOHN IRELAND, Governor of the State of "
        "Texas, by virtue of the authority vested in me by law, and in accordance with the "
        "Act of the Legislature approved February 4, 1856, granting lands to the Texas and "
        "Pacific Railway Company for the construction of its line of railway, and by virtue "
        "of Certificate No. 57/2-14 issued to said Company, have GRANTED, and by these "
        "presents do GRANT unto the <b>TEXAS AND PACIFIC RAILWAY COMPANY</b>, its successors "
        "and assigns forever, " + LEGAL + "; the field notes of which are on file in the "
        "General Land Office."),
      P("TO HAVE AND TO HOLD the said land, with all the hereditaments and appurtenances "
        "thereto belonging, unto the said Texas and Pacific Railway Company, its successors "
        "and assigns forever."),
      P("IN TESTIMONY WHEREOF, I have caused the Seal of the State to be affixed, as well as "
        "the Seal of the General Land Office, at the City of Austin, this 20th day of June, "
        "A.D. 1884."),
      sig("JOHN IRELAND, Governor"),
      sig("W. C. WALSH, Commissioner of the General Land Office"),
      rec("August 2, 1886, at 9:00 o'clock A.M.", "August 4, 1886",
          "Deed Records of Reeves County, Texas, Volume A, Page 12", "J. W. TAYLOR")],
     subtitle="Patent No. 211, Vol. 37 &mdash; General Land Office")

# 2 ─ T&P to Josiah Harlan
inst("Deed Records Vol. 9, Page 233", "DEED",
     dict(date="1902-03-14", rec="Vol. 9, Pg. 233 (DR)", type="Deed",
          grantor="Texas and Pacific Railway Company", grantee="Josiah B. Harlan",
          interest="100% fee"),
     [P("THE STATE OF TEXAS } COUNTY OF DALLAS } KNOW ALL MEN BY THESE PRESENTS:"),
      P("That the TEXAS AND PACIFIC RAILWAY COMPANY, a corporation, acting herein by and "
        "through its Land Trustees, FRANK B. HORNE and CHARLES E. SATTERLEE, for and in "
        "consideration of the sum of Nine Hundred Sixty and No/100 Dollars ($960.00), being "
        "One and 50/100 Dollars per acre, to it in hand paid by <b>JOSIAH B. HARLAN</b>, of "
        "Reeves County, Texas, the receipt of which is hereby acknowledged, has GRANTED, SOLD "
        "and CONVEYED, and by these presents does GRANT, SELL and CONVEY unto the said Josiah "
        "B. Harlan the following described land, to-wit:"),
      P(LEGAL + ", being the same land patented to the Texas and Pacific Railway Company by "
        "the State of Texas by Patent No. 211, Volume 37, dated June 20, 1884, recorded in "
        "Volume A, Page 12, Deed Records of Reeves County, Texas."),
      P("TO HAVE AND TO HOLD the above described premises, together with all and singular "
        "the rights and appurtenances thereto in anywise belonging, unto the said Josiah B. "
        "Harlan, his heirs and assigns forever; and the said Company does hereby bind itself, "
        "its successors and assigns, to WARRANT AND FOREVER DEFEND all and singular the said "
        "premises unto the said grantee, his heirs and assigns, against every person whomsoever "
        "lawfully claiming or to claim the same or any part thereof."),
      P("WITNESS the hands of said Land Trustees at Dallas, Texas, this 14th day of March, "
        "A.D. 1902."),
      sig("FRANK B. HORNE, Land Trustee"),
      sig("CHARLES E. SATTERLEE, Land Trustee"),
      *ack_corp("Frank B. Horne and Charles E. Satterlee", "Land Trustees",
                "Texas and Pacific Railway Company", "14th day of March, A.D. 1902",
                "R. L. JAMISON", county="Dallas"),
      rec("April 1, 1902, at 2:30 o'clock P.M.", "April 3, 1902",
          "Deed Records of Reeves County, Texas, Volume 9, Page 233", "J. W. TAYLOR")])

# 3 ─ Deed of Trust
inst("Deed of Trust Records Vol. 4, Page 41", "DEED OF TRUST",
     dict(date="1908-01-09", rec="Vol. 4, Pg. 41 (DTR)", type="Deed of Trust",
          grantor="Josiah B. Harlan and wife Martha E. Harlan",
          grantee="W. T. Bassett, Trustee for First State Bank of Pecos",
          interest="Lien only; released by Vol. 22, Pg. 310"),
     [P("THE STATE OF TEXAS } COUNTY OF REEVES } KNOW ALL MEN BY THESE PRESENTS:"),
      P("That we, <b>JOSIAH B. HARLAN and wife, MARTHA E. HARLAN</b>, of Reeves County, "
        "Texas, hereinafter called Grantors, for the purpose of securing the indebtedness "
        "hereinafter described, and in consideration of the sum of One Dollar to us in hand "
        "paid by the Trustee hereinafter named, have GRANTED, SOLD and CONVEYED, and by these "
        "presents do GRANT, SELL and CONVEY unto <b>W. T. BASSETT, TRUSTEE</b>, of Reeves "
        "County, Texas, the following described property, to-wit:"),
      P(LEGAL + ", being the same land conveyed to Josiah B. Harlan by the Texas and Pacific "
        "Railway Company by deed dated March 14, 1902, recorded in Volume 9, Page 233, Deed "
        "Records of Reeves County, Texas."),
      P("This conveyance is made in TRUST to secure the payment of one certain promissory "
        "note of even date herewith, in the principal sum of Two Thousand Four Hundred and "
        "No/100 Dollars ($2,400.00), executed by Grantors and payable to the order of "
        "<b>FIRST STATE BANK OF PECOS</b>, at Pecos, Texas, on or before five years after "
        "date, bearing interest at the rate of eight per cent per annum."),
      P("Should Grantors make default in the payment of said note or any installment of "
        "interest thereon, the Trustee, at the request of the holder of said note, shall sell "
        "said property at public vendue to the highest bidder for cash at the door of the "
        "Court House of Reeves County, Texas, after advertising the time, place and terms of "
        "said sale as required by law, and shall execute a deed to the purchaser."),
      P("WITNESS our hands this 9th day of January, A.D. 1908."),
      sig("JOSIAH B. HARLAN"), sig("MARTHA E. HARLAN"),
      *ack_couple("Josiah B. Harlan", "Martha E. Harlan", "9th day of January, A.D. 1908",
                  "C. W. NEWELL"),
      rec("January 10, 1908, at 11:00 o'clock A.M.", "January 13, 1908",
          "Deed of Trust Records of Reeves County, Texas, Volume 4, Page 41", "J. W. TAYLOR")])

# 4 ─ Release of DT
inst("Deed Records Vol. 22, Page 310", "RELEASE OF DEED OF TRUST LIEN",
     dict(date="1913-02-17", rec="Vol. 22, Pg. 310 (DR)", type="Release",
          grantor="First State Bank of Pecos", grantee="Josiah B. Harlan and wife",
          interest="Releases Vol. 4, Pg. 41 (DTR)"),
     [P("THE STATE OF TEXAS } COUNTY OF REEVES } KNOW ALL MEN BY THESE PRESENTS:"),
      P("That FIRST STATE BANK OF PECOS, a banking corporation, of Pecos, Reeves County, "
        "Texas, the legal owner and holder of one certain promissory note in the principal "
        "sum of $2,400.00, dated January 9, 1908, executed by Josiah B. Harlan and wife, "
        "Martha E. Harlan, and secured by a Deed of Trust of even date therewith to W. T. "
        "Bassett, Trustee, recorded in Volume 4, Page 41, Deed of Trust Records of Reeves "
        "County, Texas, covering " + LEGAL + ";"),
      P("for and in consideration of the full and final payment of said note, together with "
        "all interest thereon, the receipt of which is hereby acknowledged, does hereby "
        "RELEASE, DISCHARGE and QUITCLAIM unto the said Josiah B. Harlan and wife, Martha E. "
        "Harlan, their heirs and assigns, all the right, title, interest and lien which it "
        "has in and to the above described land by virtue of said note and Deed of Trust."),
      P("WITNESS the hand of said Bank by its Cashier this 17th day of February, A.D. 1913."),
      sig("FIRST STATE BANK OF PECOS", "By: E. L. ROGERS, Cashier"),
      *ack_corp("E. L. Rogers", "Cashier", "First State Bank of Pecos",
                "17th day of February, A.D. 1913", "C. W. NEWELL"),
      rec("February 20, 1913, at 10:00 o'clock A.M.", "February 21, 1913",
          "Deed Records of Reeves County, Texas, Volume 22, Page 310", "S. C. VAUGHAN")])

# 5 ─ Mineral Deed to Ashby
inst("Deed Records Vol. 31, Page 77", "MINERAL DEED",
     dict(date="1917-08-22", rec="Vol. 31, Pg. 77 (DR)", type="Mineral Deed",
          grantor="Josiah B. Harlan and wife Martha E. Harlan", grantee="Clement R. Ashby",
          interest="Undivided 1/2 mineral interest"),
     [P("THE STATE OF TEXAS } COUNTY OF REEVES } KNOW ALL MEN BY THESE PRESENTS:"),
      P("That we, <b>JOSIAH B. HARLAN and wife, MARTHA E. HARLAN</b>, of Reeves County, "
        "Texas, hereinafter called Grantors, for and in consideration of the sum of Three "
        "Thousand Two Hundred and No/100 Dollars ($3,200.00) cash in hand paid by "
        "<b>CLEMENT R. ASHBY</b>, of Fort Worth, Tarrant County, Texas, hereinafter called "
        "Grantee, the receipt of which is hereby acknowledged, have GRANTED, SOLD, CONVEYED, "
        "ASSIGNED and DELIVERED, and by these presents do GRANT, SELL, CONVEY, ASSIGN and "
        "DELIVER unto the said Grantee an <b>undivided one-half (1/2) interest</b> in and to "
        "all of the oil, gas and other minerals in, on and under, and that may be produced "
        "from, the following described land, to-wit:"),
      P(LEGAL + ", being the same land described in deed from the Texas and Pacific Railway "
        "Company to Josiah B. Harlan dated March 14, 1902, recorded in Volume 9, Page 233, "
        "Deed Records of Reeves County, Texas;"),
      P("together with the right of ingress and egress at all times for the purpose of "
        "mining, drilling and exploring said land for oil, gas and other minerals, and "
        "removing the same therefrom."),
      P("Said land not being presently under lease, it is understood and agreed that Grantee "
        "shall own one-half (1/2) of all bonus, rentals and royalties under any future lease, "
        "and that Grantee shall have the right to join in the execution of any such lease."),
      P("TO HAVE AND TO HOLD the above described property, together with all and singular "
        "the rights and appurtenances thereto in anywise belonging, unto the said Grantee, "
        "his heirs and assigns forever, and Grantors do hereby bind themselves, their heirs, "
        "executors and administrators, to WARRANT AND FOREVER DEFEND all and singular the said "
        "property unto the said Grantee, his heirs and assigns, against every person "
        "whomsoever lawfully claiming or to claim the same or any part thereof."),
      P("WITNESS our hands this 22nd day of August, A.D. 1917."),
      sig("JOSIAH B. HARLAN"), sig("MARTHA E. HARLAN"),
      *ack_couple("Josiah B. Harlan", "Martha E. Harlan", "22nd day of August, A.D. 1917",
                  "H. G. BIGGS"),
      rec("August 25, 1917, at 3:15 o'clock P.M.", "August 28, 1917",
          "Deed Records of Reeves County, Texas, Volume 31, Page 77", "S. C. VAUGHAN")])

# 6 ─ Probate of Josiah Harlan
inst("Deed Records Vol. 40, Page 502", "PROBATE OF WILL &mdash; ESTATE OF JOSIAH B. HARLAN",
     dict(date="1921-05-02", rec="Vol. 40, Pg. 502 (DR)", type="Probate (Cause No. 412)",
          grantor="Estate of Josiah B. Harlan, Deceased", grantee="Martha E. Harlan",
          interest="All of decedent's estate (surface + remaining 1/2 MI)"),
     [Paragraph("CERTIFIED COPY", S_SUB),
      Paragraph("LAST WILL AND TESTAMENT OF JOSIAH B. HARLAN", S_SUB),
      P("I, JOSIAH B. HARLAN, of Reeves County, Texas, being of sound and disposing mind and "
        "memory, do make and publish this my last will and testament, hereby revoking all "
        "wills by me heretofore made."),
      P("FIRST: I direct that all of my just debts and funeral expenses be paid as soon "
        "after my death as practicable."),
      P("SECOND: I give, devise and bequeath all of the property of which I may die seized "
        "and possessed, real, personal and mixed, wherever situated, including specifically "
        "my ranch lands in Reeves County, Texas, known as Section 14, Block 57, and all oil, "
        "gas and minerals thereunder which I have not heretofore conveyed, unto my beloved "
        "wife, <b>MARTHA E. HARLAN</b>, in fee simple, to be hers absolutely."),
      P("THIRD: I appoint my said wife, Martha E. Harlan, Independent Executrix of this will, "
        "and direct that no bond be required of her and that no other action be had in the "
        "County Court in relation to the settlement of my estate than the probating and "
        "recording of this will and the return of an inventory, appraisement and list of "
        "claims."),
      P("IN WITNESS WHEREOF I have hereunto set my hand at Pecos, Texas, this 3rd day of "
        "October, A.D. 1919."),
      sig("JOSIAH B. HARLAN"),
      P("Signed, published and declared by the said Josiah B. Harlan as his last will and "
        "testament in our presence, and we, at his request and in his presence and in the "
        "presence of each other, have hereunto subscribed our names as witnesses."),
      sig("D. M. PRICHARD, Witness"), sig("ANNA L. KELLER, Witness"),
      CondPageBreak(3 * inch),
      Paragraph("ORDER ADMITTING WILL TO PROBATE", S_SUB),
      Paragraph("Cause No. 412 &mdash; In the County Court of Reeves County, Texas &mdash; "
                "Estate of Josiah B. Harlan, Deceased", S_SUB),
      P("On this the 18th day of April, A.D. 1921, came on to be heard the application of "
        "Martha E. Harlan for the probate of the last will and testament of Josiah B. Harlan, "
        "Deceased, and the Court, having heard the evidence, finds that the said Josiah B. "
        "Harlan died on the 11th day of January, A.D. 1921, in Reeves County, Texas, where he "
        "had his domicile; that four years have not elapsed since his death; that the Court "
        "has jurisdiction and venue; that citation has been duly served; and that said will "
        "was executed with the formalities required by law to make it a valid will."),
      P("IT IS THEREFORE ORDERED, ADJUDGED AND DECREED that said will be and it is hereby "
        "admitted to probate, and that Martha E. Harlan be appointed Independent Executrix "
        "thereof without bond, and that Letters Testamentary issue to her upon her taking the "
        "oath required by law."),
      sig("W. A. HUDSON, County Judge, Reeves County, Texas"),
      Paragraph("CLERK'S CERTIFICATE: I certify the foregoing to be a true and correct copy of "
                "the will of Josiah B. Harlan and of the order admitting the same to probate, "
                "as the same appear of record in Probate Minutes Volume 3, Page 190.", S_ACK),
      rec("May 2, 1921, at 9:30 o'clock A.M.", "May 4, 1921",
          "Deed Records of Reeves County, Texas, Volume 40, Page 502", "S. C. VAUGHAN")])

# 7 ─ Ashby to Pecos Royalty
inst("Deed Records Vol. 47, Page 118", "MINERAL DEED",
     dict(date="1924-11-05", rec="Vol. 47, Pg. 118 (DR)", type="Mineral Deed",
          grantor="Clement R. Ashby and wife Florence Ashby", grantee="Pecos Royalty Company",
          interest="Undivided 1/4 mineral interest (half of Ashby's 1/2)"),
     [P("THE STATE OF TEXAS } COUNTY OF TARRANT } KNOW ALL MEN BY THESE PRESENTS:"),
      P("That we, <b>CLEMENT R. ASHBY and wife, FLORENCE ASHBY</b>, of Tarrant County, "
        "Texas, for and in consideration of the sum of Ten Dollars and other good and "
        "valuable consideration paid by <b>PECOS ROYALTY COMPANY</b>, a Texas corporation, "
        "have GRANTED, SOLD and CONVEYED, and do hereby GRANT, SELL and CONVEY unto said "
        "Pecos Royalty Company an <b>undivided one-fourth (1/4) interest</b> in and to all of "
        "the oil, gas and other minerals in and under and that may be produced from " + LEGAL
        + "."),
      P("The interest herein conveyed is a part of, and is taken out of, the undivided "
        "one-half (1/2) mineral interest conveyed to Clement R. Ashby by Josiah B. Harlan and "
        "wife, Martha E. Harlan, by Mineral Deed dated August 22, 1917, recorded in Volume 31, "
        "Page 77, Deed Records of Reeves County, Texas, it being the intention of Grantors to "
        "convey one-half of the interest so acquired and to retain the remaining undivided "
        "one-fourth (1/4) mineral interest."),
      P("Grantee shall receive one-fourth (1/4) of all bonus, delay rentals and royalties "
        "accruing under any lease now or hereafter covering said land."),
      P("TO HAVE AND TO HOLD unto the said Pecos Royalty Company, its successors and assigns "
        "forever, and Grantors bind themselves, their heirs and legal representatives to "
        "WARRANT AND FOREVER DEFEND the title to said interest unto Grantee against every "
        "person whomsoever lawfully claiming or to claim the same or any part thereof."),
      P("WITNESS our hands this 5th day of November, A.D. 1924."),
      sig("CLEMENT R. ASHBY"), sig("FLORENCE ASHBY"),
      *ack_couple("Clement R. Ashby", "Florence Ashby", "5th day of November, A.D. 1924",
                  "J. M. HENDRICKS", county="Tarrant"),
      rec("November 12, 1924, at 1:00 o'clock P.M.", "November 14, 1924",
          "Deed Records of Reeves County, Texas, Volume 47, Page 118", "S. C. VAUGHAN")])

# 8 ─ 1926 Lease
inst("Oil and Gas Lease Records Vol. 3, Page 9", "OIL AND GAS LEASE",
     dict(date="1926-03-15", rec="Vol. 3, Pg. 9 (OGL)", type="Oil and Gas Lease",
          grantor="Martha E. Harlan; Clement R. Ashby; Pecos Royalty Company",
          grantee="Midland Oil Corporation",
          interest="1/8 royalty, 10-year primary term; expired, released Vol. 12, Pg. 266"),
     [P("THE STATE OF TEXAS } COUNTY OF REEVES } "),
      P("AGREEMENT made and entered into this 15th day of March, 1926, by and between "
        "<b>MRS. M. E. HARLAN</b>, a widow, being one and the same person as Martha E. Harlan; "
        "<b>CLEMENT R. ASHBY</b>; and <b>PECOS ROYALTY COMPANY</b>, a Texas corporation, "
        "hereinafter called Lessor (whether one or more), and <b>MIDLAND OIL CORPORATION</b>, "
        "hereinafter called Lessee:"),
      P("1. Lessor, in consideration of Six Hundred Forty and No/100 Dollars ($640.00) in hand "
        "paid, of the royalties herein provided, and of the agreements of Lessee herein "
        "contained, hereby grants, leases and lets exclusively unto Lessee for the purpose of "
        "investigating, exploring, prospecting, drilling and mining for and producing oil, gas "
        "and all other minerals, laying pipe lines, building tanks, power stations, telephone "
        "lines and other structures thereon to produce, save, take care of, treat, transport "
        "and own said products, the following described land in Reeves County, Texas, to-wit: "
        + LEGAL + "."),
      P("2. Subject to the other provisions herein contained, this lease shall be for a term "
        "of <b>ten (10) years</b> from this date (called \"primary term\") and as long "
        "thereafter as oil, gas or other mineral is produced from said land hereunder."),
      P("3. The royalties to be paid by Lessee are: (a) on oil, <b>one-eighth (1/8)</b> of "
        "that produced and saved from said land, the same to be delivered at the wells or to "
        "the credit of Lessor into the pipe line to which the wells may be connected; (b) on "
        "gas, including casinghead gas, produced from said land and sold or used off the "
        "premises, the market value at the well of one-eighth (1/8) of the gas so sold or "
        "used."),
      P("4. If operations for drilling are not commenced on said land on or before one year "
        "from this date, this lease shall terminate as to both parties, unless on or before "
        "such anniversary date Lessee shall pay or tender to Lessor the sum of One Dollar per "
        "acre, which shall operate as a rental and cover the privilege of deferring the "
        "commencement of drilling operations for a period of twelve months."),
      P("5. If said Lessor owns a less interest in the above described land than the entire "
        "and undivided fee simple estate therein, then the royalties and rentals herein "
        "provided for shall be paid the Lessor only in the proportion which Lessor's interest "
        "bears to the whole and undivided fee. Lessors own the mineral estate as follows: Mrs. "
        "M. E. Harlan, an undivided one-half (1/2); Clement R. Ashby, an undivided one-fourth "
        "(1/4); and Pecos Royalty Company, an undivided one-fourth (1/4)."),
      P("IN WITNESS WHEREOF, this instrument is executed on the date first above written."),
      sig("MRS. M. E. HARLAN"), sig("CLEMENT R. ASHBY"),
      sig("PECOS ROYALTY COMPANY", "By: HOWARD T. LEMLEY, President"),
      *ack_one("Mrs. M. E. Harlan, a widow", "March 15, 1926", "H. G. BIGGS"),
      *ack_one("Clement R. Ashby", "March 17, 1926", "J. M. HENDRICKS", county="Tarrant"),
      *ack_corp("Howard T. Lemley", "President", "Pecos Royalty Company", "18th day of March, 1926",
                "J. M. HENDRICKS", county="Tarrant"),
      rec("March 29, 1926, at 10:45 o'clock A.M.", "March 31, 1926",
          "Oil and Gas Lease Records of Reeves County, Texas, Volume 3, Page 9", "S. C. VAUGHAN")])

# 9 ─ Release of 1926 Lease
inst("Oil and Gas Lease Records Vol. 12, Page 266", "RELEASE OF OIL AND GAS LEASE",
     dict(date="1937-01-20", rec="Vol. 12, Pg. 266 (OGL)", type="Release of Lease",
          grantor="Midland Oil Corporation", grantee="Lessors of record",
          interest="Releases 1926 lease, Vol. 3, Pg. 9 (OGL)"),
     [P("THE STATE OF TEXAS } COUNTY OF MIDLAND } KNOW ALL MEN BY THESE PRESENTS:"),
      P("That MIDLAND OIL CORPORATION, the owner and holder of that certain Oil and Gas Lease "
        "dated March 15, 1926, from Mrs. M. E. Harlan, a widow, Clement R. Ashby and Pecos "
        "Royalty Company, as Lessors, to Midland Oil Corporation, as Lessee, recorded in "
        "Volume 3, Page 9, Oil and Gas Lease Records of Reeves County, Texas, covering "
        + LEGAL + ";"),
      P("the primary term of said lease having expired on March 15, 1936, without production "
        "of oil, gas or other minerals having been obtained from said land, and no drilling "
        "or reworking operations being then in progress thereon, does hereby RELEASE, "
        "RELINQUISH and SURRENDER unto the Lessors, their heirs, successors and assigns, all "
        "right, title and interest in and to said lease and the lands covered thereby."),
      P("EXECUTED this 20th day of January, 1937."),
      sig("MIDLAND OIL CORPORATION", "By: R. B. CULLUM, Vice President"),
      *ack_corp("R. B. Cullum", "Vice President", "Midland Oil Corporation",
                "20th day of January, 1937", "MARY E. SNEED", county="Midland"),
      rec("February 1, 1937, at 2:00 o'clock P.M.", "February 3, 1937",
          "Oil and Gas Lease Records of Reeves County, Texas, Volume 12, Page 266",
          "LOUISE B. FOWLER")])

# 10 ─ Affidavit of Heirship, Martha
inst("Deed Records Vol. 88, Page 41", "AFFIDAVIT OF FACTS CONCERNING IDENTITY OF HEIRS",
     dict(date="1938-06-30", rec="Vol. 88, Pg. 41 (DR)", type="Affidavit of Heirship",
          grantor="Estate of Martha E. Harlan, Deceased (intestate, d. 1935)",
          grantee="Thomas H. Harlan and Eliza Harlan Pruitt (1/2 each)",
          interest="Martha's surface + 1/2 MI, in equal shares"),
     [P("THE STATE OF TEXAS } COUNTY OF REEVES }"),
      P("BEFORE ME, the undersigned authority, on this day personally appeared <b>GEORGE W. "
        "PRICHARD</b>, who, being by me first duly sworn, upon his oath deposes and says:"),
      P("1. I am a resident of Reeves County, Texas, and have resided here since 1899. I was "
        "well acquainted with MARTHA E. HARLAN, also known as Mrs. M. E. Harlan, for more than "
        "thirty years prior to her death. I am not related to her by blood or marriage and I "
        "claim no interest in her estate."),
      P("2. Martha E. Harlan died intestate in Pecos, Reeves County, Texas, on September 4, "
        "1935. No administration has been had upon her estate, none is necessary, and all "
        "debts of her estate have been paid. She left no will, to the best of my knowledge "
        "and belief, after diligent inquiry."),
      P("3. Martha E. Harlan was married only once, to JOSIAH B. HARLAN, who predeceased her "
        "on January 11, 1921, and whose will was probated in Cause No. 412, County Court of "
        "Reeves County, Texas, recorded in Volume 40, Page 502, Deed Records of Reeves County, "
        "Texas, by which will all of his property passed to her. She did not remarry."),
      P("4. Two children were born to the marriage of Josiah B. Harlan and Martha E. Harlan, "
        "and no other children were born to or adopted by Martha E. Harlan, namely: "
        "(a) <b>THOMAS H. HARLAN</b>, born 1889, now living in Reeves County, Texas; and "
        "(b) <b>ELIZA HARLAN PRUITT</b>, born 1893, wife of Walter Pruitt, now living in Ward "
        "County, Texas. No child of the decedent predeceased her."),
      P("5. At her death Martha E. Harlan owned " + LEGAL + ", SAVE AND EXCEPT an undivided "
        "one-half (1/2) of the oil, gas and other minerals previously conveyed to Clement R. "
        "Ashby by Mineral Deed recorded in Volume 31, Page 77, Deed Records of Reeves County, "
        "Texas."),
      sig("GEORGE W. PRICHARD, Affiant"),
      Paragraph("SUBSCRIBED AND SWORN TO before me this 30th day of June, 1938.<br/>"
                "LOUISE B. FOWLER, County Clerk, Reeves County, Texas", S_ACK),
      rec("June 30, 1938, at 4:00 o'clock P.M.", "July 2, 1938",
          "Deed Records of Reeves County, Texas, Volume 88, Page 41", "LOUISE B. FOWLER")])

# 11 ─ Eliza to Thomas, reserving floating NPRI
inst("Deed Records Vol. 96, Page 377", "WARRANTY DEED WITH RESERVATION OF ROYALTY",
     dict(date="1940-04-08", rec="Vol. 96, Pg. 377 (DR)", type="Warranty Deed",
          grantor="Eliza Harlan Pruitt and husband Walter Pruitt",
          grantee="Thomas H. Harlan (separate property)",
          interest="Undivided 1/2 surface + 1/4 MI; reserves NPRI = 1/2 of royalty on the "
                   "interest conveyed (floating)"),
     [P("THE STATE OF TEXAS } COUNTY OF WARD } KNOW ALL MEN BY THESE PRESENTS:"),
      P("That I, <b>ELIZA HARLAN PRUITT</b>, joined pro forma by my husband, <b>WALTER "
        "PRUITT</b>, of Ward County, Texas, hereinafter called Grantor, for and in "
        "consideration of the sum of Four Thousand Five Hundred and No/100 Dollars ($4,500.00) "
        "cash paid by <b>THOMAS H. HARLAN</b>, out of his sole and separate funds, the receipt "
        "of which is hereby acknowledged, have GRANTED, SOLD and CONVEYED, and by these "
        "presents do GRANT, SELL and CONVEY unto the said Thomas H. Harlan, as his sole and "
        "separate property, all of my undivided interest, being an undivided one-half (1/2) "
        "interest, in and to the following described land, to-wit:"),
      P(LEGAL + ", which interest I inherited from my mother, Martha E. Harlan, Deceased, as "
        "shown by Affidavit of Heirship recorded in Volume 88, Page 41, Deed Records of Reeves "
        "County, Texas."),
      P("This conveyance is made subject to the undivided one-half (1/2) of the oil, gas and "
        "other minerals heretofore conveyed by Josiah B. Harlan and wife to Clement R. Ashby "
        "by deed recorded in Volume 31, Page 77, Deed Records of Reeves County, Texas, it being "
        "understood that the mineral interest owned by Grantor and conveyed hereby is an "
        "undivided one-fourth (1/4) of the oil, gas and other minerals."),
      P("<b>RESERVATION.</b> There is EXCEPTED from this conveyance and RESERVED unto Grantor, "
        "her heirs and assigns, <b>an undivided one-half (1/2) of the royalty</b> that may "
        "hereafter be payable on oil, gas and other minerals produced from said land "
        "attributable to the undivided one-fourth (1/4) mineral interest herein conveyed, "
        "whether such royalty be one-eighth or some greater or lesser fraction. Grantor shall "
        "not participate in the execution of oil and gas leases, nor share in any bonus or "
        "delay rentals, all of which rights are conveyed to and vested in Grantee, his heirs "
        "and assigns. The interest so reserved is a non-participating royalty."),
      P("TO HAVE AND TO HOLD the above described premises, subject to said reservation, unto "
        "the said Thomas H. Harlan, his heirs and assigns forever; and I do hereby bind myself, "
        "my heirs, executors and administrators, to WARRANT AND FOREVER DEFEND the said "
        "premises unto the said Grantee, his heirs and assigns, against every person "
        "whomsoever lawfully claiming or to claim the same or any part thereof."),
      P("WITNESS our hands this 8th day of April, A.D. 1940."),
      sig("ELIZA HARLAN PRUITT"), sig("WALTER PRUITT"),
      *ack_couple("Walter Pruitt", "Eliza Harlan Pruitt", "8th day of April, A.D. 1940",
                  "O. B. MAYFIELD", county="Ward"),
      rec("April 15, 1940, at 9:00 o'clock A.M.", "April 17, 1940",
          "Deed Records of Reeves County, Texas, Volume 96, Page 377", "LOUISE B. FOWLER")])

# 12 ─ Ancillary probate, Ashby
inst("Deed Records Vol. 141, Page 15", "ANCILLARY PROBATE &mdash; ESTATE OF CLEMENT R. ASHBY",
     dict(date="1948-10-11", rec="Vol. 141, Pg. 15 (DR)", type="Ancillary Probate",
          grantor="Estate of Clement R. Ashby, Deceased (d. 1947, Tarrant Co.)",
          grantee="Lucille Ashby Brandt",
          interest="Ashby's remaining undivided 1/4 MI"),
     [Paragraph("Certified Copy of Will and Order of Probate from Tarrant County, Texas, "
                "Filed for Record in Reeves County, Texas", S_SUB),
      P("I, CLEMENT R. ASHBY, of Fort Worth, Tarrant County, Texas, declare this to be my last "
        "will and testament."),
      P("ARTICLE I. My beloved wife, Florence Ashby, having died on March 2, 1944, I make no "
        "provision for her."),
      P("ARTICLE II. I give, devise and bequeath all of my property and estate of every kind "
        "and character, real, personal or mixed, and wherever situated, including all of my "
        "oil, gas and mineral interests in Reeves County, Texas, to my only child, my "
        "daughter, <b>LUCILLE ASHBY BRANDT</b>, in fee simple."),
      P("ARTICLE III. I appoint my daughter, Lucille Ashby Brandt, Independent Executrix of "
        "this will, to serve without bond."),
      P("SIGNED this 14th day of July, 1945."),
      sig("CLEMENT R. ASHBY"),
      sig("J. W. ROGERS, Witness"), sig("HELEN P. DEAN, Witness"),
      Paragraph("ORDER PROBATING WILL &mdash; Cause No. 31,882, Probate Court of Tarrant County, "
                "Texas", S_SUB),
      P("On September 20, 1948, the Court heard the application of Lucille Ashby Brandt to "
        "probate the will of Clement R. Ashby, Deceased, and finds that the decedent died on "
        "December 9, 1947, domiciled in Tarrant County, Texas; that the will was duly "
        "executed; and that the Court has jurisdiction and venue. IT IS ORDERED that the will "
        "is admitted to probate and that Lucille Ashby Brandt is appointed Independent "
        "Executrix."),
      sig("ROY C. HARRIS, Judge of the Probate Court, Tarrant County, Texas"),
      Paragraph("The foregoing certified copies are filed in the Deed Records of Reeves County "
                "to evidence title to the undivided one-fourth (1/4) mineral interest in "
                + LEGAL_S + " standing in the name of Clement R. Ashby under Volume 31, Page "
                "77, Deed Records of Reeves County, Texas, less the 1/4 conveyed to Pecos "
                "Royalty Company at Volume 47, Page 118.", S_ACK),
      rec("October 11, 1948, at 11:20 o'clock A.M.", "October 13, 1948",
          "Deed Records of Reeves County, Texas, Volume 141, Page 15", "LOUISE B. FOWLER")])

# 13 ─ Merger
inst("Deed Records Vol. 152, Page 300", "CERTIFICATE OF MERGER",
     dict(date="1950-06-01", rec="Vol. 152, Pg. 300 (DR)", type="Certificate of Merger",
          grantor="Pecos Royalty Company", grantee="Permian Basin Royalty Corporation",
          interest="Undivided 1/4 MI by operation of law"),
     [Paragraph("THE STATE OF TEXAS &mdash; OFFICE OF THE SECRETARY OF STATE", S_SUB),
      P("I, JOHN BEN SHEPPERD, Secretary of State of the State of Texas, DO HEREBY CERTIFY "
        "that Articles of Merger of <b>PECOS ROYALTY COMPANY</b>, a Texas corporation, Charter "
        "No. 41107, into <b>PERMIAN BASIN ROYALTY CORPORATION</b>, a Texas corporation, Charter "
        "No. 88214, duly signed and verified pursuant to the provisions of the laws of the "
        "State of Texas, have been received in this office and are found to conform to law."),
      P("ACCORDINGLY, the undersigned, as Secretary of State, and by virtue of the authority "
        "vested in him by law, hereby issues this Certificate of Merger, effective June 1, "
        "1950. Permian Basin Royalty Corporation is the surviving corporation, and the "
        "separate existence of Pecos Royalty Company has ceased. All property, real, personal "
        "and mixed, of Pecos Royalty Company is vested in the surviving corporation without "
        "further act or deed."),
      sig("JOHN BEN SHEPPERD, Secretary of State"),
      P("Filed in Reeves County by the surviving corporation to evidence its succession to "
        "the undivided one-fourth (1/4) mineral interest in " + LEGAL + ", acquired by Pecos "
        "Royalty Company by Mineral Deed recorded in Volume 47, Page 118, Deed Records of "
        "Reeves County, Texas."),
      sig("PERMIAN BASIN ROYALTY CORPORATION", "By: C. D. WHITTAKER, Secretary"),
      rec("July 19, 1950, at 10:00 o'clock A.M.", "July 21, 1950",
          "Deed Records of Reeves County, Texas, Volume 152, Page 300", "LOUISE B. FOWLER")])

# 14 ─ Probate of Thomas Harlan
inst("Deed Records Vol. 168, Page 211", "PROBATE OF WILL &mdash; ESTATE OF THOMAS H. HARLAN",
     dict(date="1952-09-08", rec="Vol. 168, Pg. 211 (DR)", type="Probate (Cause No. 1187)",
          grantor="Estate of Thomas H. Harlan, Deceased",
          grantee="Clara Harlan (surface); Robert J. Harlan, Mary Harlan Coker, Samuel E. "
                  "Harlan (minerals, 1/3 each)",
          interest="Thomas's 1/2 MI (burdened by Pruitt NPRI) to three children; surface to Clara"),
     [Paragraph("CERTIFIED COPY", S_SUB),
      Paragraph("LAST WILL AND TESTAMENT OF THOMAS H. HARLAN", S_SUB),
      P("I, THOMAS H. HARLAN, a resident of Reeves County, Texas, being of sound mind, make "
        "this my last will and testament and revoke all prior wills and codicils."),
      P("ONE. I am married to CLARA HARLAN. I have three children: ROBERT J. HARLAN, MARY "
        "HARLAN COKER, and SAMUEL E. HARLAN. The lands hereinafter mentioned are my separate "
        "property, having been acquired by inheritance from my mother and by purchase from my "
        "sister with my separate funds."),
      P("TWO. I give and devise to my wife, <b>CLARA HARLAN</b>, all of the surface estate of "
        + LEGAL + ", together with the improvements thereon, but excluding all oil, gas and "
        "other minerals in and under said land."),
      P("THREE. I give and devise all of the oil, gas and other minerals, and all royalty "
        "and leasing rights, owned by me in said Section 14, Block 57, to my three children, "
        "<b>ROBERT J. HARLAN, MARY HARLAN COKER and SAMUEL E. HARLAN</b>, in equal shares, "
        "share and share alike."),
      P("FOUR. I give all the rest and residue of my estate to my wife, Clara Harlan."),
      P("FIVE. I appoint my wife, Clara Harlan, Independent Executrix of this will, and "
        "direct that no bond be required of her."),
      P("SIGNED this 2nd day of February, 1950."),
      sig("THOMAS H. HARLAN"),
      sig("B. F. COLLIER, Witness"), sig("NELL WARD, Witness"),
      CondPageBreak(3 * inch),
      Paragraph("ORDER ADMITTING WILL TO PROBATE &mdash; Cause No. 1187, County Court of Reeves "
                "County, Texas", S_SUB),
      P("On August 25, 1952, came on to be heard the application of Clara Harlan for probate "
        "of the will of Thomas H. Harlan, Deceased. The Court finds that the decedent died on "
        "May 19, 1952, domiciled in Reeves County, Texas; that the will was executed with the "
        "formalities required by law; and that the Court has jurisdiction and venue. IT IS "
        "ORDERED that the will be admitted to probate and that Clara Harlan be appointed "
        "Independent Executrix without bond."),
      sig("G. C. GIBSON, County Judge, Reeves County, Texas"),
      rec("September 8, 1952, at 8:45 o'clock A.M.", "September 10, 1952",
          "Deed Records of Reeves County, Texas, Volume 168, Page 211", "VERA G. MOORE")])

# 15 ─ 1955 Lease
inst("Oil and Gas Lease Records Vol. 61, Page 140", "OIL, GAS AND MINERAL LEASE",
     dict(date="1955-02-10", rec="Vol. 61, Pg. 140 (OGL)", type="Oil and Gas Lease",
          grantor="Robert J. Harlan; Mary Harlan Coker; Samuel E. Harlan; Lucille Ashby Brandt; "
                  "Permian Basin Royalty Corporation",
          grantee="Hondo Petroleum Company",
          interest="1/8 royalty, 5-year primary term; terminated, released Vol. 288, Pg. 33"),
     [P("THIS AGREEMENT made this 10th day of February, 1955, between <b>ROBERT J. HARLAN</b>, "
        "a single man; <b>MARY HARLAN COKER</b>, joined by her husband, JAMES COKER; <b>SAMUEL "
        "E. HARLAN</b>, a married man, dealing with his separate property; <b>LUCILLE ASHBY "
        "BRANDT</b>, joined by her husband, KARL BRANDT; and <b>PERMIAN BASIN ROYALTY "
        "CORPORATION</b>, a Texas corporation, Lessor (whether one or more), and <b>HONDO "
        "PETROLEUM COMPANY</b>, Lessee, WITNESSETH:"),
      P("1. Lessor, in consideration of Six Thousand Four Hundred and No/100 Dollars "
        "($6,400.00), in hand paid, of the royalties herein provided, and of the agreements of "
        "Lessee herein contained, hereby grants, leases and lets exclusively unto Lessee for "
        "the purpose of investigating, exploring, prospecting, drilling and mining for and "
        "producing oil, gas and all other minerals, the following described land in Reeves "
        "County, Texas: " + LEGAL + "."),
      P("2. Subject to the other provisions herein contained, this lease shall be for a term "
        "of <b>five (5) years</b> from this date (called \"primary term\") and as long "
        "thereafter as oil, gas or other mineral is produced from said land or land with which "
        "said land is pooled hereunder."),
      P("3. The royalties to be paid by Lessee are: (a) on oil, <b>one-eighth (1/8)</b> of "
        "that produced and saved from said land; (b) on gas, including casinghead gas or other "
        "gaseous substance, produced from said land and sold or used off the premises, the "
        "market value at the well of one-eighth (1/8) of the gas so sold or used."),
      P("4. If at the expiration of the primary term oil, gas or other mineral is not being "
        "produced on said land, but Lessee is then engaged in drilling or reworking operations "
        "thereon, the lease shall remain in force so long as operations are prosecuted with "
        "no cessation of more than sixty (60) consecutive days. If, after the expiration of "
        "the primary term, production should cease from any cause, this lease shall not "
        "terminate if Lessee commences additional drilling or reworking operations within "
        "sixty (60) days thereafter."),
      P("5. Lessors represent that they own the mineral estate in the following undivided "
        "proportions, and royalties shall be paid accordingly: Robert J. Harlan, 1/6; Mary "
        "Harlan Coker, 1/6; Samuel E. Harlan, 1/6; Lucille Ashby Brandt, 1/4; Permian Basin "
        "Royalty Corporation, 1/4. The Harlan interests are subject to the non-participating "
        "royalty reserved in deed recorded in Volume 96, Page 377, Deed Records of Reeves "
        "County, Texas."),
      P("IN WITNESS WHEREOF, this instrument is executed on the date first above written."),
      sig("ROBERT J. HARLAN"), sig("MARY HARLAN COKER"), sig("JAMES COKER"),
      sig("SAMUEL E. HARLAN"), sig("LUCILLE ASHBY BRANDT"), sig("KARL BRANDT"),
      sig("PERMIAN BASIN ROYALTY CORPORATION", "By: C. D. WHITTAKER, Vice President"),
      *ack_one("Robert J. Harlan, a single man", "February 10, 1955", "OPAL HUNNICUTT"),
      *ack_couple("James Coker", "Mary Harlan Coker", "10th day of February, 1955",
                  "OPAL HUNNICUTT"),
      *ack_one("Samuel E. Harlan", "February 11, 1955", "OPAL HUNNICUTT"),
      *ack_couple("Karl Brandt", "Lucille Ashby Brandt", "15th day of February, 1955",
                  "J. D. FARRIS", county="Tarrant"),
      *ack_corp("C. D. Whittaker", "Vice President", "Permian Basin Royalty Corporation",
                "16th day of February, 1955", "ALMA REESE", county="Midland"),
      rec("February 28, 1955, at 9:10 o'clock A.M.", "March 2, 1955",
          "Oil and Gas Lease Records of Reeves County, Texas, Volume 61, Page 140",
          "VERA G. MOORE")])

# 16 ─ Assignment Hondo to Trans-Pecos with ORRI
inst("Oil and Gas Lease Records Vol. 66, Page 402",
     "ASSIGNMENT OF OIL AND GAS LEASE WITH RESERVATION OF OVERRIDING ROYALTY",
     dict(date="1956-05-21", rec="Vol. 66, Pg. 402 (OGL)", type="Assignment of Lease",
          grantor="Hondo Petroleum Company", grantee="Trans-Pecos Exploration Company",
          interest="100% WI in 1955 lease; Hondo reserves 1/16 ORRI (dies with the 1955 lease)"),
     [P("THE STATE OF TEXAS } COUNTY OF MIDLAND } KNOW ALL MEN BY THESE PRESENTS:"),
      P("That <b>HONDO PETROLEUM COMPANY</b>, a Delaware corporation, hereinafter called "
        "Assignor, for and in consideration of Ten Dollars and other valuable consideration, "
        "does hereby TRANSFER, ASSIGN and CONVEY unto <b>TRANS-PECOS EXPLORATION COMPANY</b>, "
        "hereinafter called Assignee, all of Assignor's right, title and interest in and to "
        "that certain Oil, Gas and Mineral Lease dated February 10, 1955, from Robert J. "
        "Harlan, et al, as Lessors, to Hondo Petroleum Company, as Lessee, recorded in Volume "
        "61, Page 140, Oil and Gas Lease Records of Reeves County, Texas, insofar as it covers "
        + LEGAL + "."),
      P("<b>RESERVATION.</b> Assignor EXCEPTS and RESERVES unto itself, its successors and "
        "assigns, an overriding royalty of <b>one-sixteenth (1/16) of eight-eighths (8/8)</b> "
        "of all oil, gas and other minerals produced, saved and marketed from said land under "
        "the terms of said lease, free of all costs of development and operation, but subject "
        "to its proportionate part of production and severance taxes. Said overriding royalty "
        "shall apply only to said lease and shall not extend to any renewal or extension "
        "thereof or to any new lease covering said land."),
      P("Assignee assumes and agrees to perform all of the obligations of Lessee under said "
        "lease insofar as the same pertain to the interest hereby assigned."),
      P("EXECUTED this 21st day of May, 1956."),
      sig("HONDO PETROLEUM COMPANY", "By: W. L. GARNER, President"),
      *ack_corp("W. L. Garner", "President", "Hondo Petroleum Company", "21st day of May, 1956",
                "ALMA REESE", county="Midland"),
      rec("June 4, 1956, at 1:30 o'clock P.M.", "June 6, 1956",
          "Oil and Gas Lease Records of Reeves County, Texas, Volume 66, Page 402",
          "VERA G. MOORE")])

# 17 ─ Affidavit of Production 1958
inst("Oil and Gas Lease Records Vol. 79, Page 18", "AFFIDAVIT OF PRODUCTION",
     dict(date="1958-03-03", rec="Vol. 79, Pg. 18 (OGL)", type="Affidavit of Production",
          grantor="Trans-Pecos Exploration Company", grantee="Public notice",
          interest="Harlan No. 1 completed 1957; 1955 lease held by production"),
     [P("THE STATE OF TEXAS } COUNTY OF REEVES }"),
      P("BEFORE ME, the undersigned authority, personally appeared <b>H. E. DUNLAP</b>, who, "
        "being duly sworn, stated that he is District Superintendent for TRANS-PECOS "
        "EXPLORATION COMPANY, owner of the Oil, Gas and Mineral Lease dated February 10, 1955, "
        "recorded in Volume 61, Page 140, Oil and Gas Lease Records of Reeves County, Texas, by "
        "assignment recorded in Volume 66, Page 402, said records, covering " + LEGAL + "; and "
        "that he has personal knowledge of the following facts:"),
      P("That the <b>Trans-Pecos Exploration Company Harlan No. 1</b> well, located 1,980 feet "
        "from the North line and 1,980 feet from the West line of said Section 14, was spudded "
        "on August 2, 1957, and completed on November 14, 1957, in the Delaware formation as a "
        "well capable of producing oil and gas in paying quantities; that oil has been "
        "continuously produced and sold therefrom since November 1957; and that said lease is "
        "in full force and effect."),
      sig("H. E. DUNLAP"),
      Paragraph("SWORN TO AND SUBSCRIBED before me this 3rd day of March, 1958.<br/>"
                "OPAL HUNNICUTT, Notary Public, Reeves County, Texas", S_ACK),
      rec("March 3, 1958, at 3:00 o'clock P.M.", "March 5, 1958",
          "Oil and Gas Lease Records of Reeves County, Texas, Volume 79, Page 18",
          "VERA G. MOORE")])

# 18 ─ Heirship, Eliza
inst("Deed Records Vol. 212, Page 88", "AFFIDAVIT OF HEIRSHIP",
     dict(date="1960-11-14", rec="Vol. 212, Pg. 88 (DR)", type="Affidavit of Heirship",
          grantor="Estate of Eliza Harlan Pruitt, Deceased (intestate, d. 1959)",
          grantee="Daniel Pruitt and Ruth Pruitt Odell (1/2 each)",
          interest="Pruitt NPRI, in equal shares"),
     [P("THE STATE OF TEXAS } COUNTY OF WARD }"),
      P("BEFORE ME, the undersigned authority, on this day personally appeared <b>ALBERT C. "
        "LINDSEY</b>, who, being by me duly sworn, on oath deposed and said:"),
      P("I knew ELIZA HARLAN PRUITT for more than twenty-five years before her death and I am "
        "not related to her or to any of her heirs. She died intestate in Monahans, Ward "
        "County, Texas, on December 30, 1959. No administration is pending upon her estate and "
        "none is necessary."),
      P("Eliza Harlan Pruitt was married only once, to WALTER PRUITT, who predeceased her, "
        "having died on April 6, 1955. Two children were born to their marriage, and no other "
        "children were born to or adopted by her: <b>DANIEL PRUITT</b>, of Ward County, Texas, "
        "and <b>RUTH PRUITT ODELL</b>, wife of Lee Odell, of Ector County, Texas. Both "
        "survived her."),
      P("Among the property owned by Eliza Harlan Pruitt at her death was the non-participating "
        "royalty interest reserved to her in Warranty Deed to Thomas H. Harlan dated April 8, "
        "1940, recorded in Volume 96, Page 377, Deed Records of Reeves County, Texas, covering "
        + LEGAL + ". Said royalty was inherited by her from her mother, Martha E. Harlan, and "
        "was her separate property."),
      sig("ALBERT C. LINDSEY, Affiant"),
      Paragraph("SWORN TO AND SUBSCRIBED before me this 14th day of November, 1960.<br/>"
                "O. B. MAYFIELD, Notary Public, Ward County, Texas", S_ACK),
      rec("November 21, 1960, at 10:00 o'clock A.M.", "November 23, 1960",
          "Deed Records of Reeves County, Texas, Volume 212, Page 88", "VERA G. MOORE")])

# 19 ─ Samuel to Crestline, wrong section
inst("Deed Records Vol. 249, Page 501", "MINERAL DEED",
     dict(date="1965-07-12", rec="Vol. 249, Pg. 501 (DR)", type="Mineral Deed",
          grantor="Samuel E. Harlan", grantee="Crestline Royalty Partners",
          interest="Undivided 1/6 MI (describes Section 41 in error; corrected Vol. 266, Pg. 12)"),
     [P("THE STATE OF TEXAS } COUNTY OF REEVES } KNOW ALL MEN BY THESE PRESENTS:"),
      P("That I, <b>SAMUEL E. HARLAN</b>, dealing herein with my sole and separate property, "
        "for and in consideration of Ten Dollars and other good and valuable consideration "
        "paid by <b>CRESTLINE ROYALTY PARTNERS</b>, a Texas general partnership, of Dallas, "
        "Texas, have GRANTED, SOLD and CONVEYED, and do hereby GRANT, SELL and CONVEY unto "
        "Grantee an <b>undivided one-sixth (1/6) interest</b> in and to all of the oil, gas "
        "and other minerals in and under and that may be produced from the following "
        "described land, to-wit:"),
      P(LEGAL_WRONG + ", being the interest devised to me under the will of my father, Thomas "
        "H. Harlan, Deceased, probated in Cause No. 1187, County Court of Reeves County, Texas, "
        "recorded in Volume 168, Page 211, Deed Records of Reeves County, Texas."),
      P("This conveyance is made subject to the Oil, Gas and Mineral Lease recorded in Volume "
        "61, Page 140, Oil and Gas Lease Records of Reeves County, Texas, but covers and "
        "includes one-sixth (1/6) of all royalties and other benefits accruing thereunder from "
        "and after the date hereof; and is further subject to the non-participating royalty "
        "reserved in deed recorded in Volume 96, Page 377, Deed Records of Reeves County, "
        "Texas."),
      P("TO HAVE AND TO HOLD unto Grantee, its successors and assigns forever, and I bind "
        "myself, my heirs and legal representatives, to WARRANT AND FOREVER DEFEND the title "
        "to said interest unto Grantee against every person whomsoever lawfully claiming or to "
        "claim the same or any part thereof."),
      P("WITNESS my hand this 12th day of July, 1965."),
      sig("SAMUEL E. HARLAN"),
      *ack_one("Samuel E. Harlan", "July 12, 1965", "OPAL HUNNICUTT"),
      rec("July 19, 1965, at 11:00 o'clock A.M.", "July 21, 1965",
          "Deed Records of Reeves County, Texas, Volume 249, Page 501", "VERA G. MOORE")])

# 20 ─ Correction deed
inst("Deed Records Vol. 266, Page 12", "CORRECTION MINERAL DEED",
     dict(date="1967-03-01", rec="Vol. 266, Pg. 12 (DR)", type="Correction Mineral Deed",
          grantor="Samuel E. Harlan", grantee="Crestline Royalty Partners",
          interest="Corrects legal description in Vol. 249, Pg. 501 to Section 14"),
     [P("THE STATE OF TEXAS } COUNTY OF REEVES } KNOW ALL MEN BY THESE PRESENTS:"),
      P("WHEREAS, by Mineral Deed dated July 12, 1965, recorded in Volume 249, Page 501, Deed "
        "Records of Reeves County, Texas, <b>SAMUEL E. HARLAN</b>, as Grantor, conveyed to "
        "<b>CRESTLINE ROYALTY PARTNERS</b>, as Grantee, an undivided one-sixth (1/6) interest "
        "in the oil, gas and other minerals under land described therein as Section Forty-One "
        "(41), Block 57, Township 2, T&amp;P Ry. Co. Survey, Abstract No. 3318, Reeves County, "
        "Texas; and"),
      P("WHEREAS, there is no Section 41 in said Block 57, Township 2, and Abstract No. 3318 "
        "covers Section 14; the description of the section number was a typographical error, "
        "it having been the intention of the parties to convey the interest of Grantor in "
        "Section 14, as shown by the reference therein to the will of Thomas H. Harlan "
        "recorded in Volume 168, Page 211, Deed Records of Reeves County, Texas;"),
      P("NOW, THEREFORE, for the consideration recited in the original deed, Grantor does "
        "hereby GRANT, SELL and CONVEY unto Crestline Royalty Partners an undivided one-sixth "
        "(1/6) interest in and to all of the oil, gas and other minerals in and under and that "
        "may be produced from " + LEGAL + ", and Grantor ratifies and confirms said Mineral "
        "Deed as so corrected, effective as of July 12, 1965. In all other respects said "
        "Mineral Deed shall remain unchanged."),
      P("WITNESS my hand this 1st day of March, 1967."),
      sig("SAMUEL E. HARLAN"),
      sig("CRESTLINE ROYALTY PARTNERS", "By: DONALD R. MEEKS, Managing Partner"),
      *ack_one("Samuel E. Harlan", "March 1, 1967", "OPAL HUNNICUTT"),
      *ack_one("Donald R. Meeks", "March 3, 1967", "SUSAN K. BLAIR", county="Dallas",
               capacity="Managing Partner of Crestline Royalty Partners, a Texas general "
                        "partnership, on behalf of said partnership"),
      rec("March 9, 1967, at 2:00 o'clock P.M.", "March 13, 1967",
          "Deed Records of Reeves County, Texas, Volume 266, Page 12", "VERA G. MOORE")])

# 21 ─ Heirship, Robert (intestate, mother survives)
inst("Deed Records Vol. 301, Page 255", "AFFIDAVIT OF HEIRSHIP",
     dict(date="1973-04-16", rec="Vol. 301, Pg. 255 (DR)", type="Affidavit of Heirship",
          grantor="Estate of Robert J. Harlan, Deceased (intestate, d. 1971)",
          grantee="Clara Harlan (1/2); Mary Harlan Coker (1/4); Samuel E. Harlan (1/4)",
          interest="Robert's 1/6 MI: Clara 1/12, Mary 1/24, Samuel 1/24"),
     [P("THE STATE OF TEXAS } COUNTY OF REEVES }"),
      P("BEFORE ME, the undersigned authority, on this day personally appeared <b>RAYMOND T. "
        "HOLLIS</b>, who, being by me first duly sworn, upon his oath deposes and says:"),
      P("1. I knew ROBERT J. HARLAN from his childhood until his death, a period of more than "
        "forty years. I am not related to him or to any member of his family and claim no "
        "interest in his estate."),
      P("2. Robert J. Harlan died intestate in Pecos, Reeves County, Texas, on October 22, "
        "1971. No administration has been had upon his estate and none is necessary. All "
        "debts have been paid."),
      P("3. Robert J. Harlan never married, and no children were born to or adopted by him."),
      P("4. His father, THOMAS H. HARLAN, predeceased him, having died May 19, 1952. His "
        "mother, <b>CLARA HARLAN</b>, survived him and is now living in Pecos, Texas."),
      P("5. Robert J. Harlan had two siblings, both of the whole blood, both of whom survived "
        "him: <b>MARY HARLAN COKER</b>, of Reeves County, Texas, and <b>SAMUEL E. HARLAN</b>, "
        "of Midland County, Texas. He had no other brothers or sisters, of the whole or half "
        "blood."),
      P("6. At his death Robert J. Harlan owned an undivided one-sixth (1/6) of the oil, gas "
        "and other minerals in " + LEGAL + ", devised to him under the will of Thomas H. "
        "Harlan recorded in Volume 168, Page 211, Deed Records of Reeves County, Texas, "
        "subject to the non-participating royalty reserved in Volume 96, Page 377."),
      sig("RAYMOND T. HOLLIS, Affiant"),
      Paragraph("SUBSCRIBED AND SWORN TO before me this 16th day of April, 1973.<br/>"
                "OPAL HUNNICUTT, Notary Public, Reeves County, Texas", S_ACK),
      rec("April 18, 1973, at 9:00 o'clock A.M.", "April 20, 1973",
          "Deed Records of Reeves County, Texas, Volume 301, Page 255", "BILLIE J. GOLLADAY")])

# 22 ─ Probate, Clara
inst("Deed Records Vol. 322, Page 640", "PROBATE OF WILL &mdash; ESTATE OF CLARA HARLAN",
     dict(date="1976-02-23", rec="Vol. 322, Pg. 640 (DR)", type="Probate (Cause No. 2894)",
          grantor="Estate of Clara Harlan, Deceased (d. 1975)",
          grantee="Mary Harlan Coker",
          interest="Surface of Section 14 + Clara's 1/12 MI"),
     [Paragraph("CERTIFIED COPY", S_SUB),
      Paragraph("LAST WILL AND TESTAMENT OF CLARA HARLAN", S_SUB),
      P("I, CLARA HARLAN, a widow, of Reeves County, Texas, make this my last will."),
      P("I give, devise and bequeath all of my property, real and personal, wherever located, "
        "including the surface of Section 14, Block 57, Reeves County, Texas, which I received "
        "under the will of my late husband, Thomas H. Harlan, and any oil, gas and mineral "
        "interests which I inherited from my late son, Robert J. Harlan, to my daughter, "
        "<b>MARY HARLAN COKER</b>. I make no provision for my son Samuel E. Harlan, not from "
        "lack of affection, but because he has been otherwise provided for."),
      P("I appoint my daughter, Mary Harlan Coker, Independent Executrix, without bond."),
      P("SIGNED this 9th day of June, 1972."),
      sig("CLARA HARLAN"), sig("W. D. PARRISH, Witness"), sig("JUNE A. TEAGUE, Witness"),
      Paragraph("ORDER ADMITTING WILL TO PROBATE &mdash; Cause No. 2894, County Court of Reeves "
                "County, Texas", S_SUB),
      P("On February 9, 1976, the Court heard the application of Mary Harlan Coker to probate "
        "the will of Clara Harlan, Deceased, and finds that the decedent died on November 30, "
        "1975, domiciled in Reeves County, Texas; that the will was duly executed and is "
        "self-proved; and that the Court has jurisdiction and venue. IT IS ORDERED that the "
        "will be admitted to probate and that Mary Harlan Coker be appointed Independent "
        "Executrix without bond."),
      sig("JOHN W. MARTIN, County Judge, Reeves County, Texas"),
      rec("February 23, 1976, at 10:15 o'clock A.M.", "February 25, 1976",
          "Deed Records of Reeves County, Texas, Volume 322, Page 640", "BILLIE J. GOLLADAY")])

# 23 ─ Release of 1955 lease
inst("Oil and Gas Lease Records Vol. 288, Page 33", "RELEASE OF OIL, GAS AND MINERAL LEASE",
     dict(date="1980-01-15", rec="Vol. 288, Pg. 33 (OGL)", type="Release of Lease",
          grantor="Trans-Pecos Exploration Company", grantee="Lessors of record",
          interest="Releases 1955 lease (Vol. 61, Pg. 140); Hondo 1/16 ORRI extinguished"),
     [P("THE STATE OF TEXAS } COUNTY OF MIDLAND } KNOW ALL MEN BY THESE PRESENTS:"),
      P("That <b>TRANS-PECOS EXPLORATION COMPANY</b>, owner of the Oil, Gas and Mineral Lease "
        "dated February 10, 1955, from Robert J. Harlan, et al, to Hondo Petroleum Company, "
        "recorded in Volume 61, Page 140, Oil and Gas Lease Records of Reeves County, Texas, "
        "and assigned to it by instrument recorded in Volume 66, Page 402, said records, "
        "covering " + LEGAL + ";"),
      P("the Harlan No. 1 well, the only well on said lease, having ceased to produce on "
        "April 2, 1979, and having been plugged and abandoned on September 18, 1979, and no "
        "operations having been commenced within the time provided in said lease, does hereby "
        "acknowledge that said lease has terminated by its own terms, and does hereby RELEASE "
        "and SURRENDER unto the Lessors, their heirs, successors and assigns, all of its right, "
        "title and interest in and to said lease and the land covered thereby."),
      P("EXECUTED this 15th day of January, 1980."),
      sig("TRANS-PECOS EXPLORATION COMPANY", "By: GARY L. TOWNSEND, Attorney-in-Fact"),
      *ack_corp("Gary L. Townsend", "Attorney-in-Fact", "Trans-Pecos Exploration Company",
                "15th day of January, 1980", "DEBRA K. WHITE", county="Midland"),
      rec("January 24, 1980, at 9:00 o'clock A.M.", "January 28, 1980",
          "Oil and Gas Lease Records of Reeves County, Texas, Volume 288, Page 33",
          "BILLIE J. GOLLADAY")])

# 24 ─ 1981 Lease (the producing lease)
inst("Oil and Gas Lease Records Vol. 301, Page 515", "PAID UP OIL AND GAS LEASE",
     dict(date="1981-06-01", rec="Vol. 301, Pg. 515 (OGL)", type="Oil and Gas Lease",
          grantor="Mary Harlan Coker; Crestline Royalty Partners; Samuel E. Harlan; Lucille "
                  "Ashby Brandt; Permian Basin Royalty Corporation",
          grantee="Coyanosa Energy, Inc.",
          interest="3/16 royalty, 3-year primary term, pooling clause; still in force"),
     [P("THIS LEASE AGREEMENT is made as of the 1st day of June, 1981, between <b>MARY HARLAN "
        "COKER</b>, joined by her husband, JAMES COKER; <b>CRESTLINE ROYALTY PARTNERS</b>, a "
        "Texas general partnership; <b>SAMUEL E. HARLAN</b>, dealing with his separate "
        "property; <b>LUCILLE ASHBY BRANDT</b>, a widow; and <b>PERMIAN BASIN ROYALTY "
        "CORPORATION</b>, a Texas corporation, as Lessor (whether one or more), and "
        "<b>COYANOSA ENERGY, INC.</b>, a Texas corporation, as Lessee."),
      P("1. GRANTING CLAUSE. In consideration of a cash bonus in hand paid and the covenants "
        "herein contained, Lessor hereby grants, leases and lets exclusively to Lessee the "
        "following described land, hereinafter called leased premises: " + LEGAL + ", for "
        "the purpose of exploring for, developing, producing and marketing oil and gas, along "
        "with all hydrocarbon and non-hydrocarbon substances produced in association "
        "therewith."),
      P("2. PRIMARY TERM. This lease, which is a \"paid-up\" lease requiring no rentals, "
        "shall be in force for a primary term of <b>three (3) years</b> from the date hereof, "
        "and for as long thereafter as oil or gas or other substances covered hereby are "
        "produced in paying quantities from the leased premises or from lands pooled "
        "therewith or this lease is otherwise maintained in effect pursuant to the provisions "
        "hereof."),
      P("3. ROYALTY. Royalties on oil, gas and other substances produced and saved hereunder "
        "shall be paid by Lessee to Lessor as follows: (a) for oil and other liquid "
        "hydrocarbons, <b>three-sixteenths (3/16)</b> of such production, to be delivered at "
        "Lessee's option to Lessor at the wellhead or to Lessor's credit at the oil purchaser's "
        "transportation facilities; (b) for gas, three-sixteenths (3/16) of the proceeds "
        "realized by Lessee from the sale thereof."),
      P("4. POOLING. Lessee shall have the right but not the obligation to pool all or any "
        "part of the leased premises or interest therein with any other lands or interests, "
        "as to any or all depths or zones, and as to any or all substances covered by this "
        "lease. A unit formed by such pooling for an oil well shall not exceed 80 acres plus a "
        "maximum acreage tolerance of 10%, and for a gas well or a horizontal completion shall "
        "not exceed 640 acres plus a maximum acreage tolerance of 10%; provided that a larger "
        "unit may be formed for an oil well, gas well or horizontal completion to conform to "
        "any well spacing or density pattern prescribed or permitted by any governmental "
        "authority having jurisdiction. Lessee shall file of record a written declaration "
        "describing the unit. In the event of pooling, Lessor shall receive on production from "
        "the unit only such portion of the royalty stipulated herein as the amount of Lessor's "
        "net acreage included in the unit bears to the total gross acreage in the unit."),
      P("5. PROPORTIONATE REDUCTION. If Lessor owns less than the full mineral estate in all "
        "or any part of the leased premises, the royalties payable hereunder for any well on "
        "any part of the leased premises or lands pooled therewith shall be reduced to the "
        "proportion that Lessor's interest in such part of the leased premises bears to the "
        "full mineral estate in such part."),
      P("6. Lessors' interests as represented to Lessee: Mary Harlan Coker, 7/24; Crestline "
        "Royalty Partners, 1/6; Samuel E. Harlan, 1/24; Lucille Ashby Brandt, 1/4; Permian "
        "Basin Royalty Corporation, 1/4. Lessee is advised of the non-participating royalty "
        "reserved in Volume 96, Page 377, Deed Records, which burdens the interests derived "
        "from Thomas H. Harlan."),
      P("IN WITNESS WHEREOF, this lease is executed to be effective as of the date first "
        "written above, but upon execution shall be binding on each signatory Lessor whether "
        "or not all parties named above as Lessor sign this lease."),
      sig("MARY HARLAN COKER"), sig("JAMES COKER"),
      sig("CRESTLINE ROYALTY PARTNERS", "By: DONALD R. MEEKS, Managing Partner"),
      sig("SAMUEL E. HARLAN"), sig("LUCILLE ASHBY BRANDT"),
      sig("PERMIAN BASIN ROYALTY CORPORATION", "By: ARTHUR L. PIERCE, President"),
      *ack_one("Mary Harlan Coker and James Coker", "June 1, 1981", "DORIS M. ROYAL"),
      *ack_one("Donald R. Meeks", "June 3, 1981", "SUSAN K. BLAIR", county="Dallas",
               capacity="Managing Partner of Crestline Royalty Partners"),
      *ack_one("Samuel E. Harlan", "June 2, 1981", "DEBRA K. WHITE", county="Midland"),
      *ack_one("Lucille Ashby Brandt", "June 5, 1981", "J. D. FARRIS", county="Tarrant"),
      *ack_corp("Arthur L. Pierce", "President", "Permian Basin Royalty Corporation",
                "8th day of June, 1981", "DEBRA K. WHITE", county="Midland"),
      rec("June 15, 1981, at 8:30 o'clock A.M.", "June 17, 1981",
          "Oil and Gas Lease Records of Reeves County, Texas, Volume 301, Page 515",
          "BILLIE J. GOLLADAY")])

# 25 ─ Assignment Coyanosa to Big Spring with 2% ORRI
inst("Oil and Gas Lease Records Vol. 327, Page 90", "ASSIGNMENT OF OIL AND GAS LEASE",
     dict(date="1983-01-10", rec="Vol. 327, Pg. 90 (OGL)", type="Assignment of Lease",
          grantor="Coyanosa Energy, Inc.", grantee="Big Spring Operating Company",
          interest="100% WI in 1981 lease; Coyanosa reserves 2% of 8/8 ORRI"),
     [P("THE STATE OF TEXAS } COUNTY OF MIDLAND } KNOW ALL MEN BY THESE PRESENTS:"),
      P("<b>COYANOSA ENERGY, INC.</b>, a Texas corporation (\"Assignor\"), for good and "
        "valuable consideration, the receipt of which is acknowledged, does hereby ASSIGN, "
        "TRANSFER and CONVEY unto <b>BIG SPRING OPERATING COMPANY</b>, a Texas corporation "
        "(\"Assignee\"), all of Assignor's right, title and interest in and to the Paid Up Oil "
        "and Gas Lease dated June 1, 1981, from Mary Harlan Coker, et al, as Lessor, to "
        "Coyanosa Energy, Inc., as Lessee, recorded in Volume 301, Page 515, Oil and Gas Lease "
        "Records of Reeves County, Texas, covering " + LEGAL + ", together with all rights "
        "incident thereto."),
      P("<b>RESERVATION OF OVERRIDING ROYALTY.</b> Assignor reserves unto itself an overriding "
        "royalty interest equal to <b>two percent (2%) of eight-eighths (8/8)</b> of all oil, "
        "gas and other hydrocarbons produced, saved and sold from the leased premises, or "
        "allocated thereto under any pooled unit, free of all costs except taxes. This "
        "overriding royalty shall apply to any renewal or extension of said lease, or any new "
        "lease taken by Assignee or its affiliates within one year after termination of said "
        "lease."),
      P("EXECUTED this 10th day of January, 1983, effective as of January 1, 1983."),
      sig("COYANOSA ENERGY, INC.", "By: ROGER V. SALAZAR, President"),
      sig("BIG SPRING OPERATING COMPANY", "By: THOMAS P. KIRBY, Vice President &mdash; Land"),
      *ack_corp("Roger V. Salazar", "President", "Coyanosa Energy, Inc.",
                "10th day of January, 1983", "DEBRA K. WHITE", county="Midland"),
      rec("January 18, 1983, at 1:45 o'clock P.M.", "January 20, 1983",
          "Oil and Gas Lease Records of Reeves County, Texas, Volume 327, Page 90",
          "BILLIE J. GOLLADAY")])

# 26 ─ Pipeline easement
inst("Deed Records Vol. 371, Page 442", "RIGHT-OF-WAY AND EASEMENT",
     dict(date="1983-08-29", rec="Vol. 371, Pg. 442 (DR)", type="Pipeline Easement",
          grantor="Mary Harlan Coker and husband James Coker (surface owner)",
          grantee="El Paso Natural Gas Company",
          interest="30-ft pipeline easement across surface; no mineral effect"),
     [P("THE STATE OF TEXAS } COUNTY OF REEVES } KNOW ALL MEN BY THESE PRESENTS:"),
      P("That <b>MARY HARLAN COKER</b>, joined by her husband, <b>JAMES COKER</b>, "
        "(\"Grantor\"), owner of the surface estate of " + LEGAL + ", which surface estate "
        "Grantor acquired under the will of Clara Harlan, Deceased, recorded in Volume 322, "
        "Page 640, Deed Records of Reeves County, Texas, for and in consideration of the sum "
        "of Eight Thousand Two Hundred Fifty and No/100 Dollars ($8,250.00), does hereby GRANT "
        "and CONVEY unto <b>EL PASO NATURAL GAS COMPANY</b>, a Delaware corporation "
        "(\"Grantee\"), a right-of-way and easement thirty (30) feet in width to construct, "
        "maintain, operate, inspect, repair, replace and remove one pipeline for the "
        "transportation of natural gas, said easement being fifteen feet on either side of a "
        "centerline crossing said Section 14 from a point in the South line thereof 660 feet "
        "East of the Southwest corner, in a northeasterly direction, to a point in the East "
        "line thereof 1,320 feet South of the Northeast corner, a distance of approximately "
        "6,110 feet (370.3 rods)."),
      P("This grant covers the surface estate only and does not convey or affect any oil, gas "
        "or other minerals in or under said land. Grantee shall bury said pipeline to a depth "
        "of not less than thirty-six (36) inches below the surface and shall pay for any damage "
        "to crops, fences and livestock arising from its operations."),
      P("EXECUTED this 29th day of August, 1983."),
      sig("MARY HARLAN COKER"), sig("JAMES COKER"),
      *ack_one("Mary Harlan Coker and James Coker", "August 29, 1983", "DORIS M. ROYAL"),
      rec("September 6, 1983, at 10:30 o'clock A.M.", "September 8, 1983",
          "Deed Records of Reeves County, Texas, Volume 371, Page 442", "BILLIE J. GOLLADAY")])

# 27 ─ Affidavit of Production 1984
inst("Oil and Gas Lease Records Vol. 342, Page 61", "AFFIDAVIT OF PRODUCTION",
     dict(date="1984-04-02", rec="Vol. 342, Pg. 61 (OGL)", type="Affidavit of Production",
          grantor="Big Spring Operating Company", grantee="Public notice",
          interest="Harlan 14 No. 1 completed 1982; 1981 lease held by production"),
     [P("THE STATE OF TEXAS } COUNTY OF REEVES }"),
      P("BEFORE ME, the undersigned authority, personally appeared <b>THOMAS P. KIRBY</b>, "
        "who, being duly sworn, deposed and said that he is Vice President &mdash; Land of BIG "
        "SPRING OPERATING COMPANY, which owns the Paid Up Oil and Gas Lease dated June 1, "
        "1981, recorded in Volume 301, Page 515, Oil and Gas Lease Records of Reeves County, "
        "Texas, by assignment recorded in Volume 327, Page 90, said records, covering "
        + LEGAL + "."),
      P("Affiant states that the <b>Big Spring Operating Company Harlan 14 No. 1</b> well, "
        "located 660 feet from the South line and 1,980 feet from the East line of said "
        "Section 14, was spudded March 5, 1982, and completed August 26, 1982, in the Wolfcamp "
        "formation; that oil and gas have been produced and sold in paying quantities "
        "continuously since completion; and that said lease is in full force and effect beyond "
        "its primary term."),
      sig("THOMAS P. KIRBY"),
      Paragraph("SWORN TO AND SUBSCRIBED before me this 2nd day of April, 1984.<br/>"
                "DORIS M. ROYAL, Notary Public, State of Texas", S_ACK),
      rec("April 2, 1984, at 4:10 o'clock P.M.", "April 4, 1984",
          "Oil and Gas Lease Records of Reeves County, Texas, Volume 342, Page 61",
          "BILLIE J. GOLLADAY")])

# 28 ─ Lucille to her trust
inst("Official Public Records Vol. 512, Page 77", "MINERAL DEED",
     dict(date="1988-09-14", rec="OPR Vol. 512, Pg. 77", type="Mineral Deed",
          grantor="Lucille Ashby Brandt",
          grantee="Henry A. Brandt, Trustee of the Lucille Ashby Brandt Living Trust",
          interest="Undivided 1/4 MI"),
     [P("THE STATE OF TEXAS } COUNTY OF TARRANT } KNOW ALL PERSONS BY THESE PRESENTS:"),
      P("That <b>LUCILLE ASHBY BRANDT</b>, a widow (\"Grantor\"), for Ten Dollars and other "
        "good and valuable consideration, GRANTS, SELLS and CONVEYS unto <b>HENRY A. BRANDT, "
        "TRUSTEE OF THE LUCILLE ASHBY BRANDT LIVING TRUST</b> under trust agreement dated "
        "September 1, 1988 (\"Grantee\"), all of Grantor's right, title and interest in and to "
        "the oil, gas and other minerals in and under " + LEGAL + ", being an undivided "
        "one-fourth (1/4) mineral interest which Grantor acquired under the will of her father, "
        "Clement R. Ashby, Deceased, recorded in Volume 141, Page 15, Deed Records of Reeves "
        "County, Texas."),
      P("This conveyance is made subject to the Paid Up Oil and Gas Lease recorded in Volume "
        "301, Page 515, Oil and Gas Lease Records of Reeves County, Texas, and includes all "
        "royalties accruing thereunder after the date hereof."),
      P("TO HAVE AND TO HOLD unto Grantee and Grantee's successors in trust forever. Grantor "
        "binds herself and her heirs to WARRANT AND FOREVER DEFEND the title to said interest "
        "unto Grantee against every person lawfully claiming the same by, through or under "
        "Grantor, but not otherwise."),
      P("EXECUTED this 14th day of September, 1988."),
      sig("LUCILLE ASHBY BRANDT"),
      *ack_one("Lucille Ashby Brandt", "September 14, 1988", "KATHLEEN O'NEAL",
               county="Tarrant"),
      rec("September 26, 1988, at 9:12 A.M.", "September 27, 1988",
          "Official Public Records of Reeves County, Texas, Volume 512, Page 77",
          "DIANNE O. FLOREZ", "M. ORTEGA")])

# 29 ─ Trustee's distribution deed
inst("Official Public Records Vol. 604, Page 215", "TRUSTEE'S DISTRIBUTION MINERAL DEED",
     dict(date="1995-05-08", rec="OPR Vol. 604, Pg. 215", type="Trustee's Distribution Deed",
          grantor="Henry A. Brandt, Trustee of the Lucille Ashby Brandt Living Trust",
          grantee="Henry A. Brandt (1/8 MI); Ellen Brandt Shaw (1/8 MI)",
          interest="Trust's 1/4 MI distributed equally"),
     [P("THE STATE OF TEXAS } COUNTY OF TARRANT } KNOW ALL PERSONS BY THESE PRESENTS:"),
      P("WHEREAS, LUCILLE ASHBY BRANDT, Settlor of the Lucille Ashby Brandt Living Trust "
        "(the \"Trust\"), died on November 2, 1994; and WHEREAS, Article VI of the Trust "
        "directs that upon the death of the Settlor the Trustee shall distribute the trust "
        "estate in equal shares to the Settlor's children then living; and WHEREAS, the "
        "Settlor was survived by two children, HENRY A. BRANDT and ELLEN BRANDT SHAW, and no "
        "other children;"),
      P("NOW, THEREFORE, <b>HENRY A. BRANDT, as Trustee of the Lucille Ashby Brandt Living "
        "Trust</b>, in accordance with the terms of the Trust and without warranty except as "
        "to acts of the Trustee, does hereby GRANT, CONVEY and DISTRIBUTE all of the Trust's "
        "undivided one-fourth (1/4) interest in and to the oil, gas and other minerals in and "
        "under " + LEGAL + ", acquired by the Trust by Mineral Deed recorded in Volume 512, "
        "Page 77, Official Public Records of Reeves County, Texas, as follows:"),
      P("(a) to <b>HENRY A. BRANDT</b>, individually, an undivided one-eighth (1/8) mineral "
        "interest; and (b) to <b>ELLEN BRANDT SHAW</b>, an undivided one-eighth (1/8) mineral "
        "interest."),
      P("Each Grantee shall receive his or her proportionate share of royalties under the "
        "Paid Up Oil and Gas Lease recorded in Volume 301, Page 515, Oil and Gas Lease Records "
        "of Reeves County, Texas, from and after the first day of the month following the "
        "date hereof."),
      P("EXECUTED this 8th day of May, 1995."),
      sig("HENRY A. BRANDT, Trustee of the Lucille Ashby Brandt Living Trust"),
      *ack_one("Henry A. Brandt", "May 8, 1995", "KATHLEEN O'NEAL", county="Tarrant",
               capacity="Trustee of the Lucille Ashby Brandt Living Trust"),
      rec("May 22, 1995, at 2:40 P.M.", "May 23, 1995",
          "Official Public Records of Reeves County, Texas, Volume 604, Page 215",
          "DIANNE O. FLOREZ", "M. ORTEGA")])

# 30 ─ Surface deed Mary to Bar H Ranch
inst("Official Public Records Vol. 655, Page 380", "WARRANTY DEED (SURFACE ONLY)",
     dict(date="1998-10-19", rec="OPR Vol. 655, Pg. 380", type="Warranty Deed",
          grantor="Mary Harlan Coker, a widow", grantee="Bar H Ranch, LLC",
          interest="Surface only; all minerals excepted"),
     [P("THE STATE OF TEXAS } COUNTY OF REEVES } KNOW ALL PERSONS BY THESE PRESENTS:"),
      P("That <b>MARY HARLAN COKER</b>, a widow, her husband James Coker having died on "
        "February 11, 1996 (\"Grantor\"), for Ten Dollars and other good and valuable "
        "consideration paid by <b>BAR H RANCH, LLC</b>, a Texas limited liability company "
        "(\"Grantee\"), has GRANTED, SOLD and CONVEYED, and by these presents does GRANT, SELL "
        "and CONVEY unto Grantee the surface estate only of " + LEGAL + ", being the same "
        "surface estate acquired by Grantor under the will of Clara Harlan, Deceased, recorded "
        "in Volume 322, Page 640, Deed Records of Reeves County, Texas."),
      P("<b>EXCEPTIONS.</b> There is SAVED AND EXCEPTED from this conveyance all of the oil, "
        "gas and other minerals in, on and under said land, and all rights and interests "
        "therein, it being the intention of Grantor to convey the surface estate only. This "
        "conveyance is further made subject to (i) the right-of-way and easement to El Paso "
        "Natural Gas Company recorded in Volume 371, Page 442, Deed Records of Reeves County, "
        "Texas; (ii) the Paid Up Oil and Gas Lease recorded in Volume 301, Page 515, Oil and Gas "
        "Lease Records of Reeves County, Texas; and (iii) all other matters of record."),
      P("TO HAVE AND TO HOLD the surface estate unto Grantee, its successors and assigns "
        "forever, and Grantor binds herself, her heirs, executors and administrators, to "
        "WARRANT AND FOREVER DEFEND the same unto Grantee against every person whomsoever "
        "lawfully claiming or to claim the same or any part thereof, subject to the matters "
        "set forth above."),
      P("EXECUTED this 19th day of October, 1998."),
      sig("MARY HARLAN COKER"),
      *ack_one("Mary Harlan Coker", "October 19, 1998", "ROSA I. VILLARREAL"),
      rec("October 23, 1998, at 11:05 A.M.", "October 26, 1998",
          "Official Public Records of Reeves County, Texas, Volume 655, Page 380",
          "DIANNE O. FLOREZ", "M. ORTEGA")])

# 31 ─ PBRC to Sandhills
inst("Official Public Records Vol. 702, Page 158", "MINERAL AND ROYALTY DEED",
     dict(date="2001-03-30", rec="OPR Vol. 702, Pg. 158", type="Mineral Deed",
          grantor="Permian Basin Royalty Corporation", grantee="Sandhills Mineral Fund I, LP",
          interest="Undivided 1/4 MI"),
     [P("THE STATE OF TEXAS } COUNTY OF MIDLAND } KNOW ALL PERSONS BY THESE PRESENTS:"),
      P("<b>PERMIAN BASIN ROYALTY CORPORATION</b>, a Texas corporation, successor by merger to "
        "Pecos Royalty Company as evidenced by Certificate of Merger recorded in Volume 152, "
        "Page 300, Deed Records of Reeves County, Texas (\"Grantor\"), for Ten Dollars and other "
        "good and valuable consideration, GRANTS, SELLS, CONVEYS, ASSIGNS and DELIVERS unto "
        "<b>SANDHILLS MINERAL FUND I, LP</b>, a Delaware limited partnership (\"Grantee\"), all "
        "of Grantor's interest in and to the oil, gas and other minerals in and under " + LEGAL
        + ", being an undivided one-fourth (1/4) mineral interest acquired by Pecos Royalty "
        "Company by Mineral Deed recorded in Volume 47, Page 118, Deed Records of Reeves "
        "County, Texas."),
      P("This conveyance is made subject to the Paid Up Oil and Gas Lease recorded in Volume "
        "301, Page 515, Oil and Gas Lease Records of Reeves County, Texas, and Grantee shall "
        "receive all royalties attributable to production on and after April 1, 2001 (the "
        "\"Effective Time\")."),
      P("Grantor binds itself and its successors to WARRANT AND FOREVER DEFEND title to said "
        "interest unto Grantee against every person lawfully claiming the same by, through or "
        "under Grantor, but not otherwise."),
      P("EXECUTED this 30th day of March, 2001."),
      sig("PERMIAN BASIN ROYALTY CORPORATION", "By: LAURA J. EASTMAN, President"),
      *ack_corp("Laura J. Eastman", "President", "Permian Basin Royalty Corporation",
                "30th day of March, 2001", "TERESA A. GOMEZ", county="Midland"),
      rec("April 9, 2001, at 8:58 A.M.", "April 10, 2001",
          "Official Public Records of Reeves County, Texas, Volume 702, Page 158",
          "DIANNE O. FLOREZ", "L. SALCIDO")])

# 32 ─ Heirship, Samuel E. Harlan
inst("Official Public Records Vol. 709, Page 600", "AFFIDAVIT OF HEIRSHIP",
     dict(date="2001-06-11", rec="OPR Vol. 709, Pg. 600", type="Affidavit of Heirship",
          grantor="Estate of Samuel E. Harlan, Deceased (intestate, d. 1999)",
          grantee="Samuel E. Harlan Jr.",
          interest="Samuel's 1/24 MI (inherited from Robert, never conveyed)"),
     [P("THE STATE OF TEXAS } COUNTY OF MIDLAND }"),
      P("BEFORE ME, the undersigned authority, on this day personally appeared <b>PATRICIA "
        "L. NUNEZ</b> (\"Affiant\"), who, being duly sworn, on oath stated:"),
      P("1. My name is Patricia L. Nunez. I am over the age of eighteen and competent to make "
        "this affidavit. I was the next-door neighbor of Samuel E. Harlan in Midland, Texas, "
        "for twenty-two years. I am not related to the decedent and receive nothing from his "
        "estate."),
      P("2. SAMUEL E. HARLAN (the \"Decedent\") died intestate on August 17, 1999, in Midland, "
        "Midland County, Texas, where he was domiciled. No administration is pending and none "
        "is necessary."),
      P("3. The Decedent was married only once, to <b>DOROTHY HARLAN</b>, who predeceased him "
        "on March 3, 1994. One child was born of that marriage: <b>SAMUEL E. HARLAN JR.</b>, "
        "of Midland County, Texas, who survived the Decedent. No other children were born to "
        "or adopted by the Decedent, and no child of the Decedent predeceased him."),
      P("4. The Decedent owned an undivided one-twenty-fourth (1/24) mineral interest in "
        + LEGAL + ", which he inherited from his brother, Robert J. Harlan, as shown by "
        "Affidavit of Heirship recorded in Volume 301, Page 255, Deed Records of Reeves County, "
        "Texas. The undivided one-sixth (1/6) mineral interest the Decedent received under his "
        "father's will was conveyed by him to Crestline Royalty Partners in 1965."),
      sig("PATRICIA L. NUNEZ, Affiant"),
      Paragraph("SWORN TO AND SUBSCRIBED before me on June 11, 2001.<br/>"
                "TERESA A. GOMEZ, Notary Public, State of Texas", S_ACK),
      rec("June 18, 2001, at 3:22 P.M.", "June 19, 2001",
          "Official Public Records of Reeves County, Texas, Volume 709, Page 600",
          "DIANNE O. FLOREZ", "L. SALCIDO")])

# 33 ─ Probate, Mary Harlan Coker
inst("Official Public Records Vol. 741, Page 302",
     "PROBATE OF WILL &mdash; ESTATE OF MARY HARLAN COKER",
     dict(date="2004-01-26", rec="OPR Vol. 741, Pg. 302", type="Probate (Cause No. 6620)",
          grantor="Estate of Mary Harlan Coker, Deceased (d. 2003)",
          grantee="James Coker Jr. and Anne Coker Whitfield (1/2 each)",
          interest="Mary's 7/24 MI, 7/48 each"),
     [Paragraph("CERTIFIED COPY", S_SUB),
      Paragraph("LAST WILL AND TESTAMENT OF MARY HARLAN COKER", S_SUB),
      P("I, MARY HARLAN COKER, a resident of Reeves County, Texas, declare this to be my last "
        "will and testament, and revoke all prior wills and codicils."),
      P("ARTICLE ONE. My husband, James Coker, is deceased. I have two children, JAMES COKER "
        "JR. and ANNE COKER WHITFIELD."),
      P("ARTICLE TWO. I give all of my oil, gas and other mineral interests, royalty "
        "interests, and executive rights, wherever located, including without limitation all "
        "such interests in Section 14, Block 57, T&amp;P Ry. Co. Survey, Reeves County, Texas, "
        "to my children, <b>JAMES COKER JR.</b> and <b>ANNE COKER WHITFIELD</b>, in equal "
        "shares. If either of them does not survive me, that child's share shall pass to his "
        "or her descendants per stirpes."),
      P("ARTICLE THREE. I give the residue of my estate to my children in equal shares."),
      P("ARTICLE FOUR. I appoint my son, James Coker Jr., as Independent Executor, to serve "
        "without bond."),
      P("SIGNED this 4th day of May, 2000."),
      sig("MARY HARLAN COKER"), sig("LORENZO M. RIOS, Witness"), sig("ELAINE F. CROSS, Witness"),
      Paragraph("ORDER ADMITTING WILL TO PROBATE AND AUTHORIZING LETTERS TESTAMENTARY &mdash; "
                "Cause No. 6620, County Court of Reeves County, Texas", S_SUB),
      P("On January 12, 2004, the Court heard the application of James Coker Jr. to probate "
        "the will of Mary Harlan Coker, Deceased. The Court finds that the decedent died on "
        "September 9, 2003, domiciled in Reeves County, Texas; that four years have not "
        "elapsed since her death; that the will was self-proved; and that the Court has "
        "jurisdiction and venue. IT IS ORDERED that the will be admitted to probate, that "
        "James Coker Jr. be appointed Independent Executor without bond, and that Letters "
        "Testamentary issue to him."),
      sig("JIMMY B. GALINDO, County Judge, Reeves County, Texas"),
      rec("January 26, 2004, at 10:48 A.M.", "January 27, 2004",
          "Official Public Records of Reeves County, Texas, Volume 741, Page 302",
          "DIANNE O. FLOREZ", "L. SALCIDO")])

# 34 ─ Muniment, Daniel Pruitt
inst("Official Public Records Vol. 768, Page 455",
     "WILL PROBATED AS MUNIMENT OF TITLE &mdash; ESTATE OF DANIEL PRUITT",
     dict(date="2006-03-20", rec="OPR Vol. 768, Pg. 455", type="Muniment of Title",
          grantor="Estate of Daniel Pruitt, Deceased (d. 2005)", grantee="Linda Pruitt",
          interest="Daniel's half of the Pruitt NPRI"),
     [Paragraph("CERTIFIED COPY &mdash; Cause No. 2005-118, County Court of Ward County, Texas",
                S_SUB),
      P("I, DANIEL PRUITT, of Ward County, Texas, make this my last will and testament. I "
        "give, devise and bequeath all of my property of every kind, including all royalty "
        "interests in Reeves County, Texas, to my wife, <b>LINDA PRUITT</b>. If she does not "
        "survive me, I give my estate to my descendants per stirpes."),
      P("SIGNED this 21st day of August, 1997."),
      sig("DANIEL PRUITT"), sig("W. R. BLANTON, Witness"), sig("SHERYL A. COX, Witness"),
      Paragraph("ORDER PROBATING WILL AS MUNIMENT OF TITLE", S_SUB),
      P("On February 27, 2006, the Court heard the application of Linda Pruitt to probate the "
        "will of Daniel Pruitt, Deceased, as a muniment of title only. The Court finds that "
        "the decedent died on October 4, 2005, domiciled in Ward County, Texas; that the will "
        "was duly executed; that there are no unpaid debts owing by the estate except debts "
        "secured by liens on real estate; and that there is no necessity for administration. "
        "IT IS ORDERED that the will be admitted to probate as a muniment of title, and that "
        "this order shall constitute sufficient legal authority to all persons owing money to, "
        "having custody of property of, or acting as registrar or transfer agent of any "
        "evidence of interest in, the estate of the decedent, to pay or transfer such property "
        "to the person entitled thereto under the will."),
      sig("BRENDA K. MOORE, County Judge, Ward County, Texas"),
      P("Filed in Reeves County to evidence title to the one-half of the non-participating "
        "royalty reserved in Volume 96, Page 377, Deed Records of Reeves County, Texas, "
        "inherited by Daniel Pruitt from Eliza Harlan Pruitt as shown in Volume 212, Page 88, "
        "Deed Records of Reeves County, Texas."),
      rec("March 20, 2006, at 9:31 A.M.", "March 21, 2006",
          "Official Public Records of Reeves County, Texas, Volume 768, Page 455",
          "DIANNE O. FLOREZ", "L. SALCIDO")])

# 35 ─ Abstract of Judgment
inst("Instrument No. 2009-001922", "ABSTRACT OF JUDGMENT",
     dict(date="2009-04-14", rec="Inst. No. 2009-001922 (OPR)", type="Abstract of Judgment",
          grantor="West Texas Federal Credit Union (judgment creditor)",
          grantee="Samuel E. Harlan Jr. (judgment debtor)",
          interest="Judgment lien on Samuel Jr.'s 1/24 MI; released Inst. No. 2011-003310"),
     [Paragraph("Cause No. 08-11-20417-CVR, in the 143rd Judicial District Court of Reeves "
                "County, Texas", S_SUB),
      P("I, PATRICIA TARIN, Clerk of the 143rd Judicial District Court of Reeves County, "
        "Texas, certify that the following is a correct abstract of the judgment rendered in "
        "the above-numbered cause:"),
      P("<b>Judgment Plaintiff:</b> WEST TEXAS FEDERAL CREDIT UNION<br/>"
        "<b>Judgment Defendant:</b> SAMUEL E. HARLAN JR.<br/>"
        "<b>Defendant's Birthdate:</b> (last three digits of driver's license: 418)<br/>"
        "<b>Defendant's Last Known Address:</b> 2207 Sinclair Avenue, Midland, Texas 79705<br/>"
        "<b>Date of Judgment:</b> March 2, 2009<br/>"
        "<b>Amount of Judgment:</b> $38,612.47<br/>"
        "<b>Rate of Interest:</b> 5.00% per annum<br/>"
        "<b>Attorney's Fees:</b> $4,250.00<br/>"
        "<b>Costs of Court:</b> $412.00<br/>"
        "<b>Credits:</b> None"),
      P("This abstract is filed in the Official Public Records of Reeves County, Texas, and "
        "constitutes a lien upon all real property of the Defendant located in Reeves County, "
        "including without limitation any mineral interest in " + LEGAL_S + "."),
      P("GIVEN UNDER MY HAND AND SEAL OF OFFICE on April 14, 2009."),
      sig("PATRICIA TARIN, District Clerk, Reeves County, Texas"),
      rec("April 14, 2009, at 2:17 P.M.", "April 15, 2009",
          "Official Public Records of Reeves County, Texas, Instrument No. 2009-001922",
          "DIANNE O. FLOREZ", "L. SALCIDO")])

# 36 ─ Release of Judgment Lien
inst("Instrument No. 2011-003310", "RELEASE OF JUDGMENT LIEN",
     dict(date="2011-06-30", rec="Inst. No. 2011-003310 (OPR)", type="Release of Judgment",
          grantor="West Texas Federal Credit Union", grantee="Samuel E. Harlan Jr.",
          interest="Releases Inst. No. 2009-001922"),
     [P("THE STATE OF TEXAS } COUNTY OF MIDLAND } KNOW ALL PERSONS BY THESE PRESENTS:"),
      P("<b>WEST TEXAS FEDERAL CREDIT UNION</b>, Judgment Plaintiff in Cause No. "
        "08-11-20417-CVR, 143rd Judicial District Court of Reeves County, Texas, the owner and "
        "holder of the judgment rendered therein on March 2, 2009, against <b>SAMUEL E. "
        "HARLAN JR.</b>, the Abstract of which is recorded as Instrument No. 2009-001922, "
        "Official Public Records of Reeves County, Texas, acknowledges that said judgment, "
        "together with all interest, attorney's fees and costs, has been paid in full."),
      P("Judgment Plaintiff therefore RELEASES and DISCHARGES the judgment lien created by "
        "said Abstract of Judgment as to all real property of Samuel E. Harlan Jr. in Reeves "
        "County, Texas, including his undivided mineral interest in " + LEGAL_S + "."),
      P("EXECUTED June 30, 2011."),
      sig("WEST TEXAS FEDERAL CREDIT UNION", "By: CARLA D. VASQUEZ, Vice President of Collections"),
      *ack_corp("Carla D. Vasquez", "Vice President of Collections",
                "West Texas Federal Credit Union", "30th day of June, 2011",
                "TERESA A. GOMEZ", county="Midland"),
      rec("July 6, 2011, at 11:40 A.M.", "July 7, 2011",
          "Official Public Records of Reeves County, Texas, Instrument No. 2011-003310",
          "DIANNE O. FLOREZ", "R. HERNANDEZ")])

# 37 ─ Stipulation of Interest re NPRI
inst("Instrument No. 2012-000845", "STIPULATION OF INTEREST",
     dict(date="2012-01-23", rec="Inst. No. 2012-000845 (OPR)", type="Stipulation of Interest",
          grantor="Harlan-chain mineral owners and Pruitt NPRI owners",
          grantee="Each other / Big Spring Operating Company",
          interest="Confirms NPRI is floating: 1/2 of royalty on 1/4 MI (= 3/128 under 3/16 "
                   "lease), borne pro rata by Harlan-chain owners"),
     [P("THE STATE OF TEXAS } COUNTY OF REEVES } KNOW ALL PERSONS BY THESE PRESENTS:"),
      P("This Stipulation of Interest is entered into by the undersigned parties, being all "
        "owners of the mineral and royalty interests in " + LEGAL + " that derive from Thomas "
        "H. Harlan, Deceased, or from the royalty reserved by Eliza Harlan Pruitt in Warranty "
        "Deed dated April 8, 1940, recorded in Volume 96, Page 377, Deed Records of Reeves "
        "County, Texas (the \"1940 Deed\")."),
      P("<b>RECITALS.</b> A question has arisen as to whether the royalty reserved in the "
        "1940 Deed is a fixed fraction of production or a fraction of royalty. The parties "
        "desire to remove any doubt and to stipulate their interests for the benefit of each "
        "other and of BIG SPRING OPERATING COMPANY, operator under the Paid Up Oil and Gas "
        "Lease recorded in Volume 301, Page 515, Oil and Gas Lease Records of Reeves County, "
        "Texas (the \"Lease\")."),
      P("<b>STIPULATION.</b> The parties stipulate and agree that the royalty reserved in the "
        "1940 Deed is, and has always been, a non-participating royalty equal to one-half "
        "(1/2) of the royalty payable on the undivided one-fourth (1/4) mineral interest "
        "conveyed by the 1940 Deed, and is not a fixed fraction of production. Under the Lease, "
        "which provides a royalty of 3/16, said non-participating royalty is equal to "
        "1/2 &times; 1/4 &times; 3/16 = <b>3/128 of 8/8</b>, owned one-half each by RUTH "
        "PRUITT ODELL and LINDA PRUITT. Because Thomas H. Harlan merged the interest conveyed "
        "by the 1940 Deed with his own undivided one-fourth (1/4) mineral interest, said "
        "royalty shall be borne proportionately by all owners of the undivided one-half (1/2) "
        "mineral interest held under Thomas H. Harlan, in proportion to their respective "
        "mineral interests."),
      P("This Stipulation does not convey or affect any interest held by the successors of "
        "Clement R. Ashby or Pecos Royalty Company. It shall bind and benefit the parties and "
        "their heirs, successors and assigns, and may be executed in counterparts."),
      P("EXECUTED on the dates of the acknowledgments below, effective January 1, 2012."),
      sig("JAMES COKER JR."), sig("ANNE COKER WHITFIELD"),
      sig("CRESTLINE ROYALTY PARTNERS", "By: KEVIN R. MEEKS, Managing Partner"),
      sig("SAMUEL E. HARLAN JR."), sig("RUTH PRUITT ODELL"), sig("LINDA PRUITT"),
      *ack_one("James Coker Jr.", "January 9, 2012", "ROSA I. VILLARREAL"),
      *ack_one("Anne Coker Whitfield", "January 10, 2012", "MELISSA J. HART", county="Lubbock"),
      *ack_one("Kevin R. Meeks", "January 11, 2012", "SUSAN K. BLAIR-OWENS", county="Dallas",
               capacity="Managing Partner of Crestline Royalty Partners"),
      *ack_one("Samuel E. Harlan Jr.", "January 12, 2012", "TERESA A. GOMEZ", county="Midland"),
      *ack_one("Ruth Pruitt Odell", "January 16, 2012", "GLORIA P. SANDOVAL", county="Ector"),
      *ack_one("Linda Pruitt", "January 17, 2012", "W. R. BLANTON JR.", county="Ward"),
      rec("January 23, 2012, at 9:05 A.M.", "January 24, 2012",
          "Official Public Records of Reeves County, Texas, Instrument No. 2012-000845",
          "DIANNE O. FLOREZ", "R. HERNANDEZ")])

# 38 ─ Designation of Pooled Unit
inst("Instrument No. 2012-004417", "DESIGNATION OF POOLED UNIT &mdash; HARLAN-ASHBY 14-13 UNIT",
     dict(date="2012-08-06", rec="Inst. No. 2012-004417 (OPR)", type="Designation of Pooled Unit",
          grantor="Big Spring Operating Company", grantee="Public notice",
          interest="1,280-acre unit: Section 14 (640 ac) + Section 13 (640 ac); tract factor 0.5"),
     [P("THE STATE OF TEXAS } COUNTY OF REEVES } KNOW ALL PERSONS BY THESE PRESENTS:"),
      P("<b>BIG SPRING OPERATING COMPANY</b> (\"Designator\"), as owner of the leasehold "
        "estate in the leases described below, each of which grants to the lessee the right "
        "to pool the leased premises with other lands for the production of oil and gas, and "
        "the Railroad Commission of Texas having adopted special field rules for the "
        "Phantom (Wolfcamp) Field permitting proration units of up to 1,280 acres for "
        "horizontal wells (Oil and Gas Docket No. 08-0274651), does hereby designate and "
        "establish a pooled unit to be known as the <b>HARLAN-ASHBY 14-13 UNIT</b> (the "
        "\"Unit\"), for the production of oil and gas from the Wolfcamp formation only, "
        "consisting of the following lands:"),
      P("<b>Tract 1:</b> " + LEGAL + " (640.00 acres), covered by Paid Up Oil and Gas Lease "
        "dated June 1, 1981, from Mary Harlan Coker, et al, to Coyanosa Energy, Inc., recorded "
        "in Volume 301, Page 515, Oil and Gas Lease Records of Reeves County, Texas, as "
        "assigned to Designator by instrument recorded in Volume 327, Page 90, said records."),
      P("<b>Tract 2:</b> " + SEC13 + " (640.00 acres), covered by Oil and Gas Lease dated "
        "April 2, 2010, from Bar H Ranch, LLC, et al, to Big Spring Operating Company, "
        "recorded as Instrument No. 2010-002871, Official Public Records of Reeves County, "
        "Texas."),
      P("The Unit contains 1,280.00 acres. Production from the Unit shall be allocated to "
        "each tract in the proportion that the surface acreage of such tract bears to the "
        "total surface acreage in the Unit, as follows: Tract 1 &mdash; 640.00/1,280.00 = "
        "<b>50.000000%</b>; Tract 2 &mdash; 640.00/1,280.00 = 50.000000%. The Unit shall be "
        "effective as of the date of first production from the Harlan-Ashby 14-13 Unit 1H well."),
      P("EXECUTED August 6, 2012."),
      sig("BIG SPRING OPERATING COMPANY", "By: MEGAN L. FORSYTHE, Vice President &mdash; Land"),
      *ack_corp("Megan L. Forsythe", "Vice President &mdash; Land", "Big Spring Operating Company",
                "6th day of August, 2012", "TERESA A. GOMEZ", county="Midland"),
      rec("August 8, 2012, at 1:12 P.M.", "August 9, 2012",
          "Official Public Records of Reeves County, Texas, Instrument No. 2012-004417",
          "DIANNE O. FLOREZ", "R. HERNANDEZ")])

# 39 ─ NPRI Ratification of Unit
inst("Instrument No. 2012-004980", "RATIFICATION OF POOLED UNIT BY ROYALTY OWNERS",
     dict(date="2012-09-04", rec="Inst. No. 2012-004980 (OPR)", type="Ratification of Unit",
          grantor="Ruth Pruitt Odell and Linda Pruitt (NPRI owners)",
          grantee="Big Spring Operating Company",
          interest="NPRI owners join the Harlan-Ashby 14-13 Unit"),
     [P("THE STATE OF TEXAS } COUNTY OF REEVES } KNOW ALL PERSONS BY THESE PRESENTS:"),
      P("WHEREAS, the undersigned, <b>RUTH PRUITT ODELL</b> and <b>LINDA PRUITT</b>, are the "
        "owners of the non-participating royalty reserved in Warranty Deed dated April 8, "
        "1940, recorded in Volume 96, Page 377, Deed Records of Reeves County, Texas, "
        "covering " + LEGAL + ", as stipulated in Instrument No. 2012-000845, Official Public "
        "Records of Reeves County, Texas, which royalty interest is not subject to the pooling "
        "power granted in the oil and gas lease covering said land; and"),
      P("WHEREAS, Big Spring Operating Company has designated the Harlan-Ashby 14-13 Unit by "
        "instrument recorded as Instrument No. 2012-004417, Official Public Records of Reeves "
        "County, Texas;"),
      P("NOW, THEREFORE, for Ten Dollars and other good and valuable consideration, the "
        "undersigned do hereby RATIFY, ADOPT and CONFIRM said Designation of Pooled Unit and "
        "agree that their non-participating royalty interest in said land is pooled and "
        "unitized therein, and that they shall be paid royalty on production from the Unit "
        "in the proportion that the acreage of Tract 1 bears to the total acreage of the Unit, "
        "the same as if their interest had been subject to the pooling provisions of said "
        "lease."),
      P("EXECUTED on the dates of the acknowledgments below."),
      sig("RUTH PRUITT ODELL"), sig("LINDA PRUITT"),
      *ack_one("Ruth Pruitt Odell", "August 27, 2012", "GLORIA P. SANDOVAL", county="Ector"),
      *ack_one("Linda Pruitt", "August 29, 2012", "W. R. BLANTON JR.", county="Ward"),
      rec("September 4, 2012, at 10:20 A.M.", "September 5, 2012",
          "Official Public Records of Reeves County, Texas, Instrument No. 2012-004980",
          "DIANNE O. FLOREZ", "R. HERNANDEZ")])

# 40 ─ Affidavit of Production, horizontal well
inst("Instrument No. 2013-002106", "AFFIDAVIT OF COMPLETION AND PRODUCTION",
     dict(date="2013-04-22", rec="Inst. No. 2013-002106 (OPR)", type="Affidavit of Production",
          grantor="Big Spring Operating Company", grantee="Public notice",
          interest="Unit 1H completed 2013; Harlan 14 No. 1 plugged 2012"),
     [P("THE STATE OF TEXAS } COUNTY OF REEVES }"),
      P("BEFORE ME, the undersigned authority, personally appeared <b>MEGAN L. FORSYTHE</b>, "
        "who, being duly sworn, stated:"),
      P("1. I am Vice President &mdash; Land of Big Spring Operating Company (\"Big Spring\"), "
        "and have personal knowledge of the facts stated herein."),
      P("2. Big Spring is the owner and operator of the Paid Up Oil and Gas Lease recorded in "
        "Volume 301, Page 515, Oil and Gas Lease Records of Reeves County, Texas, covering "
        + LEGAL + "."),
      P("3. The Harlan 14 No. 1 well, completed in 1982 as described in the Affidavit of "
        "Production recorded in Volume 342, Page 61, Oil and Gas Lease Records of Reeves "
        "County, Texas, produced continuously until it was plugged and abandoned on December "
        "4, 2012, after the commencement of drilling operations on the Unit well described "
        "below."),
      P("4. The <b>Harlan-Ashby 14-13 Unit 1H</b> well, a horizontal well with surface location "
        "330 feet from the South line and 1,650 feet from the West line of Section 14 and a "
        "terminus 330 feet from the North line of Section 13, was spudded on October 15, 2012, "
        "and completed in the Wolfcamp formation on February 19, 2013. First sales of oil "
        "occurred on March 1, 2013. The well is located on the Harlan-Ashby 14-13 Unit "
        "designated by Instrument No. 2012-004417, Official Public Records of Reeves County, "
        "Texas, and is producing in paying quantities."),
      sig("MEGAN L. FORSYTHE"),
      Paragraph("SWORN TO AND SUBSCRIBED before me on April 22, 2013.<br/>"
                "ROSA I. VILLARREAL, Notary Public, State of Texas", S_ACK),
      rec("April 22, 2013, at 3:44 P.M.", "April 23, 2013",
          "Official Public Records of Reeves County, Texas, Instrument No. 2013-002106",
          "DIANNE O. FLOREZ", "R. HERNANDEZ")])

# 41 ─ Assignment Big Spring to Permian Crest
inst("Instrument No. 2014-005530", "ASSIGNMENT, CONVEYANCE AND BILL OF SALE",
     dict(date="2014-10-01", rec="Inst. No. 2014-005530 (OPR)", type="Assignment of Lease",
          grantor="Big Spring Operating Company", grantee="Permian Crest Operating, LLC",
          interest="100% WI in 1981 lease, subject to Coyanosa 2% ORRI"),
     [P("THE STATE OF TEXAS } COUNTY OF REEVES } KNOW ALL PERSONS BY THESE PRESENTS:"),
      P("<b>BIG SPRING OPERATING COMPANY</b>, a Texas corporation (\"Assignor\"), for Ten "
        "Dollars and other good and valuable consideration, does hereby GRANT, BARGAIN, SELL, "
        "ASSIGN, TRANSFER and CONVEY unto <b>PERMIAN CREST OPERATING, LLC</b>, a Delaware "
        "limited liability company (\"Assignee\"), effective as of 7:00 a.m. local time on "
        "October 1, 2014 (the \"Effective Time\"), all of Assignor's right, title and interest "
        "in and to the following (the \"Assets\"):"),
      P("(a) the Paid Up Oil and Gas Lease dated June 1, 1981, from Mary Harlan Coker, et al, "
        "to Coyanosa Energy, Inc., recorded in Volume 301, Page 515, Oil and Gas Lease Records "
        "of Reeves County, Texas, covering " + LEGAL + ", being a 100% working interest "
        "therein;"),
      P("(b) all rights in and to the Harlan-Ashby 14-13 Unit designated by Instrument No. "
        "2012-004417, Official Public Records of Reeves County, Texas, and the Harlan-Ashby "
        "14-13 Unit 1H well (API No. 42-389-33817);"),
      P("(c) all equipment, facilities, contracts, easements and records used in connection "
        "with the foregoing."),
      P("This Assignment is made SUBJECT TO (i) the overriding royalty of 2% of 8/8 reserved "
        "by Coyanosa Energy, Inc. in Assignment recorded in Volume 327, Page 90, Oil and Gas "
        "Lease Records of Reeves County, Texas; (ii) the royalty provided in said Lease; and "
        "(iii) the non-participating royalty reserved in Volume 96, Page 377, Deed Records of "
        "Reeves County, Texas, as stipulated in Instrument No. 2012-000845, Official Public "
        "Records of Reeves County, Texas. Assignor represents that the net revenue interest "
        "delivered to Assignee in Tract 1, before unit allocation, is not less than 79.25%."),
      P("Assignor warrants title to the Assets against all persons claiming by, through or "
        "under Assignor, but not otherwise."),
      P("EXECUTED on October 6, 2014, but effective as of the Effective Time."),
      sig("BIG SPRING OPERATING COMPANY", "By: MEGAN L. FORSYTHE, Vice President &mdash; Land"),
      sig("PERMIAN CREST OPERATING, LLC", "By: DEREK A. HOLLOWAY, Chief Executive Officer"),
      *ack_corp("Megan L. Forsythe", "Vice President &mdash; Land", "Big Spring Operating Company",
                "6th day of October, 2014", "TERESA A. GOMEZ", county="Midland"),
      *ack_corp("Derek A. Holloway", "Chief Executive Officer", "Permian Crest Operating, LLC",
                "6th day of October, 2014", "AMANDA C. PRICE", county="Harris"),
      rec("October 14, 2014, at 10:02 A.M.", "October 15, 2014",
          "Official Public Records of Reeves County, Texas, Instrument No. 2014-005530",
          "DIANNE O. FLOREZ", "R. HERNANDEZ")])


# ── expected ownership (computed, then checked) ──────────────────────────────
def compute_key():
    royalty = F(3, 16)
    orri = F(2, 100)
    mi = {
        "Henry A. Brandt": F(1, 8),
        "Ellen Brandt Shaw": F(1, 8),
        "Sandhills Mineral Fund I, LP": F(1, 4),
        "James Coker Jr.": F(7, 48),
        "Anne Coker Whitfield": F(7, 48),
        "Crestline Royalty Partners": F(1, 6),
        "Samuel E. Harlan Jr.": F(1, 24),
    }
    harlan_chain = {"James Coker Jr.", "Anne Coker Whitfield", "Crestline Royalty Partners",
                    "Samuel E. Harlan Jr."}
    assert sum(mi.values()) == 1
    npri_total = F(1, 2) * F(1, 4) * royalty                  # 3/128
    harlan_mi = sum(mi[n] for n in harlan_chain)                # 1/2
    burden = npri_total / (harlan_mi * royalty)                 # share of Harlan royalty lost
    rows = []
    for name, m in mi.items():
        r = m * royalty * ((1 - burden) if name in harlan_chain else 1)
        rows.append(dict(owner=name, type="RI", mineral_interest=m, tract_decimal=r))
    for name in ("Ruth Pruitt Odell", "Linda Pruitt"):
        rows.append(dict(owner=name, type="NPRI", mineral_interest=None,
                         tract_decimal=npri_total / 2))
    rows.append(dict(owner="Coyanosa Energy, Inc.", type="ORRI", mineral_interest=None,
                     tract_decimal=orri))
    rows.append(dict(owner="Permian Crest Operating, LLC", type="WI (100%)",
                     mineral_interest=None, tract_decimal=1 - royalty - orri))
    assert sum(r["tract_decimal"] for r in rows) == 1
    for r in rows:
        r["unit_decimal"] = r["tract_decimal"] * F(640, 1280)
    return rows


TRAPS = [
    "1955 lease (Vol. 61/140) and Hondo's 1/16 ORRI (Vol. 66/402) are dead: the lease was "
    "released at Vol. 288/33 and the ORRI did not extend to new leases.",
    "The Pruitt NPRI (Vol. 96/377) is a floating 1/2 of royalty on a 1/4 MI, not a fixed "
    "fraction: 3/128 under the 3/16 lease (confirmed by stipulation, Inst. 2012-000845).",
    "The NPRI burdens only the Harlan chain (Coker heirs, Crestline, Samuel Jr.), pro rata; "
    "Ashby/Brandt and Pecos/PBRC/Sandhills interests are unburdened.",
    "Samuel E. Harlan's 1965 deed describes Section 41 (Vol. 249/501); the correction deed "
    "(Vol. 266/12) fixes it to Section 14.",
    "Robert J. Harlan died intestate with no spouse/children and one surviving parent: Clara "
    "takes 1/2 and the two siblings 1/4 each (Vol. 301/255).",
    "Samuel's 1/24 inherited from Robert in 1971 is NOT covered by his 1965 deed (which "
    "conveyed a specific 1/6 he already owned); it passes to Samuel Jr. (OPR 709/600).",
    "Clara's will (Vol. 322/640) gives her inherited 1/12 MI and the surface to Mary only.",
    "Thomas H. Harlan's 1940 purchase was with separate funds, so it is his separate property "
    "and his will controls all of it (no community half for Clara).",
    "The 1998 Bar H Ranch deed (OPR 655/380) is surface only; it has no mineral effect.",
    "The 2009 abstract of judgment against Samuel Jr. was released in 2011.",
    "Pecos Royalty Co. passed to Permian Basin Royalty Corp. by merger (Vol. 152/300), not "
    "by deed.",
    "Unit tract factor is 640/1,280 = 0.5; NPRI owners ratified the unit (Inst. 2012-004980).",
]


# ── rendering ────────────────────────────────────────────────────────────────
class SetRef(Flowable):
    """Zero-size marker that tells the page footer which instrument it is on."""

    def __init__(self, idx):
        super().__init__()
        self.idx = idx

    def wrap(self, *_):
        return 0, 0

    def draw(self):
        self.canv._chain_idx = self.idx


def on_page_end(canv, doc):
    idx = getattr(canv, "_chain_idx", None)
    canv.saveState()
    canv.setFont("Times-Roman", 8.5)
    if idx is not None:
        canv.drawRightString(LETTER[0] - 0.75 * inch, LETTER[1] - 0.5 * inch,
                             INSTRUMENTS[idx]["ref"].replace("&amp;", "&"))
        canv.drawString(0.75 * inch, LETTER[1] - 0.5 * inch, f"Instrument {idx + 1} of "
                        f"{len(INSTRUMENTS)}")
    canv.drawCentredString(LETTER[0] / 2, 0.45 * inch,
                           f"Reeves County, Texas — Section 14, Block 57 — page {doc.page}")
    canv.restoreState()


def build_pdf():
    doc = BaseDocTemplate(PDF_PATH, pagesize=LETTER, title="Synthetic Chain of Title — "
                          "Section 14, Block 57, Reeves County, Texas",
                          author="Titlework Analyzer test fixture",
                          leftMargin=inch, rightMargin=inch, topMargin=0.85 * inch,
                          bottomMargin=0.8 * inch)
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")
    doc.addPageTemplates([PageTemplate(id="p", frames=[frame], onPageEnd=on_page_end)])

    story = [Spacer(1, 1.6 * inch),
             Paragraph("SYNTHETIC CHAIN OF TITLE", ParagraphStyle(
                 "ct", parent=S_TITLE, fontSize=22, leading=28)),
             Spacer(1, 0.2 * inch),
             Paragraph(LEGAL, S_COVER),
             Spacer(1, 0.3 * inch),
             Paragraph(f"Copies of {len(INSTRUMENTS)} recorded instruments, 1884&ndash;2014, "
                       "as filed in the records of the County Clerk of Reeves County, Texas, "
                       "arranged in chronological order of recording.", S_COVER),
             Spacer(1, 0.6 * inch),
             Paragraph("FICTITIOUS TEST DATA. All persons, companies, instruments and recording "
                       "references are invented for software testing and do not describe any "
                       "real title.", ParagraphStyle("w", parent=S_COVER, fontSize=10,
                                                     textColor="#8a1c1c"))]
    for i, ins in enumerate(INSTRUMENTS):
        story.append(PageBreak())
        story.append(SetRef(i))
        story.append(Paragraph(ins["title"], S_TITLE))
        if ins["subtitle"]:
            story.append(Paragraph(ins["subtitle"], S_SUB))
        body = ins["body"]
        # keep the closing recording certificate with the line before it
        story.extend(body[:-2])
        story.append(KeepTogether(body[-2:]))
    doc.build(story)
    return doc.page


def fmt(fr):
    return "" if fr is None else f"{fr.numerator}/{fr.denominator}"


def write_key(rows, pages):
    md = ["# Synthetic Chain of Title &mdash; Answer Key", "",
          f"**Tract:** {LEGAL.replace('&amp;', '&')}", "",
          f"**PDF:** `synthetic_chain_of_title.pdf` ({pages} pages, {len(INSTRUMENTS)} "
          "instruments). Fictitious test data.", "",
          "## Final ownership (as of October 15, 2014)", "",
          "Lease: Paid Up OGL dated 6/1/1981, Vol. 301/515, 3/16 royalty, held by production. "
          "Unit: Harlan-Ashby 14-13 Unit, 1,280 ac; Section 14 tract factor 0.5.", "",
          "| Owner | Type | Mineral interest | Tract decimal | Unit decimal |",
          "|---|---|---|---|---|"]
    for r in rows:
        md.append(f"| {r['owner']} | {r['type']} | {fmt(r['mineral_interest'])} | "
                  f"{fmt(r['tract_decimal'])} = {float(r['tract_decimal']):.8f} | "
                  f"{float(r['unit_decimal']):.8f} |")
    md += ["", "Surface: Bar H Ranch, LLC (OPR 655/380), subject to El Paso Natural Gas "
           "pipeline easement (Vol. 371/442).", "", "## Issues the analysis should catch", ""]
    md += [f"- {t}" for t in TRAPS]
    md += ["", "## Run sheet", "",
           "| # | Date | Recording | Instrument | Grantor | Grantee | Interest / effect |",
           "|---|---|---|---|---|---|---|"]
    for i, ins in enumerate(INSTRUMENTS, 1):
        k = ins["key"]
        md.append(f"| {i} | {k['date']} | {k['rec']} | {k['type']} | {k['grantor']} | "
                  f"{k['grantee']} | {k['interest']} |")
    with open(os.path.join(OUT, "synthetic_chain_of_title_key.md"), "w") as f:
        f.write("\n".join(md).replace("&amp;", "&").replace("&mdash;", "—") + "\n")

    data = dict(
        tract=LEGAL.replace("&amp;", "&"), pages=pages,
        lease=dict(recording="Vol. 301, Pg. 515 (OGL)", royalty="3/16"),
        unit=dict(name="Harlan-Ashby 14-13 Unit", acres=1280, tract_factor="1/2"),
        ownership=[dict(owner=r["owner"], type=r["type"],
                        mineral_interest=fmt(r["mineral_interest"]) or None,
                        tract_decimal=fmt(r["tract_decimal"]),
                        tract_decimal_float=float(r["tract_decimal"]),
                        unit_decimal_float=float(r["unit_decimal"])) for r in rows],
        surface_owner="Bar H Ranch, LLC",
        issues=TRAPS,
        instruments=[dict(n=i, **ins["key"]) for i, ins in enumerate(INSTRUMENTS, 1)],
    )
    with open(os.path.join(OUT, "synthetic_chain_of_title_key.json"), "w") as f:
        json.dump(data, f, indent=2)


def main():
    os.makedirs(OUT, exist_ok=True)
    rows = compute_key()
    pages = build_pdf()
    write_key(rows, pages)
    print(f"  {os.path.relpath(PDF_PATH, HERE)}  ({pages} pages, {len(INSTRUMENTS)} instruments)")
    print("  sample-docs/synthetic_chain_of_title_key.md")
    print("  sample-docs/synthetic_chain_of_title_key.json")


if __name__ == "__main__":
    main()
