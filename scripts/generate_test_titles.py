#!/usr/bin/env python3
"""
Generate a 50-instrument chain of title as scanned PNG images for OCR/abstraction testing.
Outputs scripts/sample-docs/*.png + scripts/sample-docs/ground_truth.json

Rendering styles (by era):
  handwritten  1895–1910  Bradley Hand, sepia, foxing, heavy noise
  aged_typed   1910–1930  Courier New, cream, foxing, moderate noise
  medium_typed 1930–1950  Courier New, light cream, standard scan look
  clean_typed  1950–1962  Courier New, white, light noise

~11 docs have deliberate degradations so models must say ILLEGIBLE. The ground
truth marks those fields as None — the accuracy checker scores ILLEGIBLE as
correct and a filled value as fabrication.

Run:  python3 scripts/generate_test_titles.py
"""
import os, json, random, math
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

HERE   = os.path.dirname(os.path.abspath(__file__))
OUT    = os.path.join(HERE, "sample-docs")
W, H   = 1240, 1754          # A4 @ 150 DPI
ML, MR = 108, 108

# ── fonts ────────────────────────────────────────────────────────────────────
F_HAND  = "/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf"
F_CHANC = "/System/Library/Fonts/Supplemental/Apple Chancery.ttf"
F_TNR   = "/System/Library/Fonts/Supplemental/Times New Roman.ttf"
F_TNRB  = "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf"
F_COU   = "/System/Library/Fonts/Supplemental/Courier New.ttf"
F_COUB  = "/System/Library/Fonts/Supplemental/Courier New Bold.ttf"
F_GEO   = "/System/Library/Fonts/Supplemental/Georgia.ttf"

# ── property description ─────────────────────────────────────────────────────
LEGAL = ("the West Half (W/2) of Section 6, Block 45, T&P Railway Company "
         "Survey, Abstract No. 1247, Reeves County, Texas, containing 320 "
         "acres, more or less")
LEGAL_S = "the W/2 of Section 6, Block 45, T&P Ry. Co. Survey, A-1247, Reeves County, Texas (320 ac.)"

# ── 50-instrument chain of title ─────────────────────────────────────────────
# gt fields use the value a correct model should output.
# gt value of None means the field is degraded → expect ILLEGIBLE.
# Checked fields: GRANTOR  GRANTEE  DATE_EXECUTED  DATE_RECORDED  RECORDING_REF
DOCS = [
    # ══ 1895–1910: handwritten era ══════════════════════════════════════════
    dict(
        file="01_patent", style="handwritten",
        title="THE STATE OF TEXAS\nLAND PATENT",
        body=[
            "PATENT NO. 1847, VOLUME 25.",
            ("Know Ye: That the State of Texas, by virtue of Land Certificate "
             "No. 4412 and in consideration of the premises, has GRANTED and does "
             "GRANT unto ABSALOM W. TIDMORE, his heirs and assigns, " + LEGAL + "."),
            ("In testimony whereof I, the Governor, have caused the Seal of the "
             "State to be affixed this 12th day of April, A.D. 1895."),
            "CHARLES A. CULBERSON, Governor.",
            "Recorded in the General Land Office, Vol. 25, Page 88.",
        ],
        stamp=dict(rd="May 3, 1895", vol="1", page="44", clerk="H. B. Odom"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="The State of Texas", GRANTEE="Absalom W. Tidmore",
                DATE_EXECUTED="April 12, 1895", DATE_RECORDED="May 3, 1895",
                RECORDING_REF="Vol. 1, Page 44"),
    ),
    dict(
        file="02_wd_tidmore_clayton", style="handwritten",
        title="WARRANTY DEED",
        body=[
            "THE STATE OF TEXAS  }  COUNTY OF REEVES  }  KNOW ALL MEN:",
            ("That ABSALOM W. TIDMORE and wife, SARAH J. TIDMORE, for and in "
             "consideration of the sum of One Thousand and No/100 Dollars ($1,000.00) "
             "paid by EZRA D. CLAYTON, have GRANTED, SOLD AND CONVEYED unto said "
             "EZRA D. CLAYTON " + LEGAL + "."),
            ("TO HAVE AND TO HOLD, together with all appurtenances, unto the said "
             "Grantee, his heirs and assigns; and Grantors bind themselves to "
             "WARRANT AND FOREVER DEFEND the same."),
            "Witness our hands this 5th day of March, A.D. 1901.",
            "ABSALOM W. TIDMORE          SARAH J. TIDMORE",
        ],
        stamp=dict(rd="March 12, 1901", vol="3", page="182", clerk="H. B. Odom"),
        deg=["EZRA D. CLAYTON"], deg_stamp=False,
        gt=dict(GRANTOR="Absalom W. Tidmore and wife Sarah J. Tidmore",
                GRANTEE=None,  # degraded
                DATE_EXECUTED="March 5, 1901", DATE_RECORDED="March 12, 1901",
                RECORDING_REF="Vol. 3, Page 182"),
    ),
    dict(
        file="03_dt_clayton_pvb", style="handwritten",
        title="DEED OF TRUST",
        body=[
            "THE STATE OF TEXAS, COUNTY OF REEVES.",
            ("That EZRA D. CLAYTON (Grantor), to secure payment of a promissory "
             "note of even date in the sum of Eight Hundred Dollars ($800.00) payable "
             "to PECOS VALLEY NATIONAL BANK, has GRANTED unto G. R. AVERY, TRUSTEE, "
             + LEGAL + "."),
            ("Should Grantor default, Trustee may sell said property at public "
             "auction, after proper notice, to the highest bidder for cash."),
            "Witness my hand this 18th day of June, A.D. 1903.",
            "EZRA D. CLAYTON",
        ],
        stamp=dict(rd="June 25, 1903", vol="5", page="77", clerk="H. B. Odom"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Ezra D. Clayton",
                GRANTEE="G. R. Avery, Trustee (for Pecos Valley National Bank)",
                DATE_EXECUTED="June 18, 1903", DATE_RECORDED="June 25, 1903",
                RECORDING_REF="Vol. 5, Page 77"),
    ),
    dict(
        file="04_release_dt_pvb", style="handwritten",
        title="RELEASE OF DEED OF TRUST",
        body=[
            "THE STATE OF TEXAS, COUNTY OF REEVES.",
            ("WHEREAS, by Deed of Trust dated June 18, 1903, recorded Vol. 5, "
             "Page 77, Ezra D. Clayton conveyed land to G. R. Avery, Trustee, to "
             "secure a note to PECOS VALLEY NATIONAL BANK; and WHEREAS said note "
             "has been fully paid; NOW THEREFORE, PECOS VALLEY NATIONAL BANK hereby "
             "RELEASES AND DISCHARGES the lien on " + LEGAL_S + "."),
            "Witness its hand this 2nd day of October, A.D. 1906.",
            "PECOS VALLEY NATIONAL BANK",
            "By: C. L. Garrett, President",
        ],
        stamp=dict(rd="October 9, 1906", vol="7", page="314", clerk="H. B. Odom"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Pecos Valley National Bank",
                GRANTEE="Ezra D. Clayton (releases lien)",
                DATE_EXECUTED="October 2, 1906", DATE_RECORDED="October 9, 1906",
                RECORDING_REF="Vol. 7, Page 314"),
    ),
    # ══ 1908–1922: aged typewriter era ══════════════════════════════════════
    dict(
        file="05_wd_clayton_sons", style="aged_typed",
        title="WARRANTY DEED",
        body=[
            "THE STATE OF TEXAS  }  COUNTY OF REEVES  }  KNOW ALL MEN:",
            ("That EZRA D. CLAYTON and wife, FLORENCE M. CLAYTON, for love and "
             "affection and the sum of Ten Dollars ($10.00) paid by our sons ROY N. "
             "CLAYTON and HAROLD E. CLAYTON, have GRANTED, SOLD AND CONVEYED unto "
             "said ROY N. CLAYTON and HAROLD E. CLAYTON, in equal undivided shares, "
             + LEGAL + "."),
            ("TO HAVE AND TO HOLD unto the said Grantees, their heirs and assigns; "
             "Grantors bind themselves to WARRANT AND FOREVER DEFEND the same."),
            "Witness our hands this 14th day of February, A.D. 1908.",
            "EZRA D. CLAYTON             FLORENCE M. CLAYTON",
        ],
        stamp=dict(rd="February 20, 1908", vol="9", page="56", clerk="H. B. Odom"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Ezra D. Clayton and wife Florence M. Clayton",
                GRANTEE="Roy N. Clayton and Harold E. Clayton",
                DATE_EXECUTED="February 14, 1908", DATE_RECORDED="February 20, 1908",
                RECORDING_REF="Vol. 9, Page 56"),
    ),
    dict(
        file="06_partition_clayton", style="aged_typed",
        title="PARTITION DEED",
        body=[
            "THE STATE OF TEXAS  }  COUNTY OF REEVES  }",
            ("KNOW ALL MEN that ROY N. CLAYTON and HAROLD E. CLAYTON, owning said "
             "land as tenants in common in equal shares, have agreed to partition "
             "said land as follows:"),
            ("ROY N. CLAYTON takes and receives the East Half (E/2) of Section 6, "
             "Block 45, T&P Ry. Co. Survey, A-1247, Reeves County, Texas (160 ac.)."),
            ("HAROLD E. CLAYTON takes and receives the West Half (W/2) of Section 6, "
             "Block 45, T&P Ry. Co. Survey, A-1247, Reeves County, Texas (160 ac.)."),
            ("Each party warrants to the other peaceful possession of the parcel "
             "herein set over to him."),
            "Witness our hands this 9th day of September, A.D. 1910.",
            "ROY N. CLAYTON              HAROLD E. CLAYTON",
        ],
        stamp=dict(rd="September 15, 1910", vol="11", page="203", clerk="H. B. Odom"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Roy N. Clayton and Harold E. Clayton",
                GRANTEE="Roy N. Clayton (E/2) and Harold E. Clayton (W/2)",
                DATE_EXECUTED="September 9, 1910", DATE_RECORDED="September 15, 1910",
                RECORDING_REF="Vol. 11, Page 203"),
    ),
    dict(
        file="07_wd_harold_moseley", style="aged_typed",
        title="WARRANTY DEED",
        body=[
            "THE STATE OF TEXAS  }  COUNTY OF REEVES  }  KNOW ALL MEN:",
            ("That HAROLD E. CLAYTON and wife, VERA B. CLAYTON, for and in "
             "consideration of Two Thousand Dollars ($2,000.00) to us paid by "
             "FRANK T. MOSELEY, have GRANTED, SOLD AND CONVEYED unto said FRANK T. "
             "MOSELEY the West Half (W/2) of Section 6, Block 45, T&P Ry. Co. "
             "Survey, A-1247, Reeves County, Texas, containing 160 acres."),
            ("TO HAVE AND TO HOLD, with all appurtenances, unto the said Grantee, "
             "his heirs and assigns; and Grantors bind themselves to WARRANT AND "
             "FOREVER DEFEND the same."),
            "Witness our hands this 3rd day of November, A.D. 1914.",
            "HAROLD E. CLAYTON           VERA B. CLAYTON",
        ],
        stamp=dict(rd="November 10, 1914", vol="14", page="418", clerk="H. B. Odom"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Harold E. Clayton and wife Vera B. Clayton",
                GRANTEE="Frank T. Moseley",
                DATE_EXECUTED="November 3, 1914", DATE_RECORDED="November 10, 1914",
                RECORDING_REF="Vol. 14, Page 418"),
    ),
    dict(
        file="08_ogl_royclayton_continental", style="aged_typed",
        title="OIL AND GAS LEASE",
        body=[
            ("THIS AGREEMENT, between ROY N. CLAYTON (Lessor), and CONTINENTAL "
             "PETROLEUM COMPANY (Lessee):"),
            ("Lessor, for Ten Dollars ($10.00) and other valuable consideration, "
             "does grant and let unto Lessee for the purpose of drilling for and "
             "producing oil and gas the East Half (E/2) of Section 6, Block 45, "
             "T&P Ry. Co. Survey, A-1247, Reeves County, Texas (160 ac.)."),
            ("Term: primary term of five (5) years from this date, and as long "
             "thereafter as oil or gas is produced from said land."),
            "Royalty: one-eighth (1/8) of oil produced; 1/8 of gas value at well.",
            "Witness my hand this 1st day of May, A.D. 1915.",
            "ROY N. CLAYTON, Lessor",
        ],
        stamp=dict(rd="May 8, 1915", vol="15", page="90", clerk="H. B. Odom"),
        deg=["1st day of May"], deg_stamp=False,
        gt=dict(GRANTOR="Roy N. Clayton (Lessor)",
                GRANTEE="Continental Petroleum Company (Lessee)",
                DATE_EXECUTED=None,  # degraded
                DATE_RECORDED="May 8, 1915",
                RECORDING_REF="Vol. 15, Page 90"),
    ),
    dict(
        file="09_mineral_deed_royclayton_swmt", style="aged_typed",
        title="MINERAL DEED",
        body=[
            "THE STATE OF TEXAS  }  COUNTY OF REEVES  }  KNOW ALL MEN:",
            ("That ROY N. CLAYTON, a single man, for Five Hundred Dollars ($500.00) "
             "paid by SOUTHWESTERN MINERAL TRUST, has GRANTED unto said "
             "SOUTHWESTERN MINERAL TRUST an undivided ONE-FOURTH (1/4) interest in "
             "and to all of the oil, gas and other minerals in, on and under the "
             "E/2 of Section 6, Block 45, T&P Ry. Co. Survey, A-1247, Reeves "
             "County, Texas."),
            ("This conveyance covers and includes the right to lease said minerals "
             "and to receive all bonuses, rentals and royalties accruing thereunder."),
            "Witness my hand this 22nd day of July, A.D. 1916.",
            "ROY N. CLAYTON",
        ],
        stamp=dict(rd="July 28, 1916", vol="16", page="255", clerk="H. B. Odom"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Roy N. Clayton",
                GRANTEE="Southwestern Mineral Trust",
                DATE_EXECUTED="July 22, 1916", DATE_RECORDED="July 28, 1916",
                RECORDING_REF="Vol. 16, Page 255"),
    ),
    dict(
        file="10_assign_ogl_continental_swgas", style="aged_typed",
        title="ASSIGNMENT OF OIL AND GAS LEASE",
        body=[
            ("CONTINENTAL PETROLEUM COMPANY (Assignor), for valuable consideration, "
             "does ASSIGN and TRANSFER unto SOUTHWEST GAS CORPORATION (Assignee) "
             "all of its right, title and interest in and to that certain Oil and "
             "Gas Lease dated May 1, 1915, from Roy N. Clayton to Continental "
             "Petroleum Company, recorded Vol. 15, Page 90, Reeves County, Texas, "
             "covering the E/2 of Section 6, Block 45, T&P Ry. Co. Survey, "
             "A-1247, Reeves County, Texas."),
            "Subject to the terms and royalties of said lease.",
            "Witness its hand this 15th day of January, A.D. 1917.",
            "CONTINENTAL PETROLEUM COMPANY",
            "By: W. H. Barnard, Vice-President",
        ],
        stamp=dict(rd="January 20, 1917", vol="16", page="488", clerk="H. B. Odom"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Continental Petroleum Company",
                GRANTEE="Southwest Gas Corporation",
                DATE_EXECUTED="January 15, 1917", DATE_RECORDED="January 20, 1917",
                RECORDING_REF="Vol. 16, Page 488"),
    ),
    dict(
        file="11_release_ogl_swgas", style="aged_typed",
        title="RELEASE OF OIL AND GAS LEASE",
        body=[
            ("SOUTHWEST GAS CORPORATION, present holder of Oil and Gas Lease "
             "recorded Vol. 15, Page 90 (as assigned Vol. 16, Page 488), for "
             "valuable consideration, does hereby RELEASE, SURRENDER and QUITCLAIM "
             "unto the present owners of the E/2 of Section 6, Block 45, T&P Ry. "
             "Co. Survey, A-1247, Reeves County, Texas, all rights under said lease."),
            "Said lease is hereby declared terminated.",
            "Witness its hand this 1st day of December, A.D. 1918.",
            "SOUTHWEST GAS CORPORATION",
            "By: R. E. Stubbs, President",
        ],
        stamp=dict(rd="December 6, 1918", vol="17", page="122", clerk="H. B. Odom"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Southwest Gas Corporation",
                GRANTEE="present owners (releases lease)",
                DATE_EXECUTED="December 1, 1918", DATE_RECORDED="December 6, 1918",
                RECORDING_REF="Vol. 17, Page 122"),
    ),
    dict(
        file="12_affidavit_heirship_royclayton", style="aged_typed",
        title="AFFIDAVIT OF HEIRSHIP\n(ESTATE OF ROY N. CLAYTON)",
        body=[
            "THE STATE OF TEXAS  }  COUNTY OF REEVES  }",
            ("BEFORE ME the undersigned, personally appeared CLARA B. CLAYTON, who "
             "being duly sworn says: That ROY N. CLAYTON died intestate in Reeves "
             "County, Texas on March 8, 1919; that no administration was had on "
             "his estate; that he owned the E/2 of Section 6, Block 45, T&P Ry. "
             "Co. Survey, A-1247, Reeves County, Texas."),
            ("That the surviving heirs of said Roy N. Clayton are: his widow "
             "CLARA B. CLAYTON; his sons CECIL R. CLAYTON and WARREN T. CLAYTON; "
             "and his daughter RUTH CLAYTON PATE, all of Reeves County, Texas."),
            "CLARA B. CLAYTON, Affiant",
            "Subscribed and sworn to before me this 4th day of January, A.D. 1920.",
        ],
        stamp=dict(rd="January 8, 1920", vol="18", page="14", clerk="W. C. Travers"),
        deg=["RUTH CLAYTON PATE"], deg_stamp=False,
        gt=dict(GRANTOR="Clara B. Clayton (Affiant)",
                GRANTEE="Heirs: Clara B. Clayton, Cecil R. Clayton, Warren T. Clayton, Ruth Clayton Pate",
                DATE_EXECUTED="January 4, 1920", DATE_RECORDED="January 8, 1920",
                RECORDING_REF="Vol. 18, Page 14"),
    ),
    dict(
        file="13_wd_claytonheirs_moseley", style="aged_typed",
        title="WARRANTY DEED",
        body=[
            "THE STATE OF TEXAS  }  COUNTY OF REEVES  }  KNOW ALL MEN:",
            ("That CLARA B. CLAYTON, widow; CECIL R. CLAYTON, single; WARREN T. "
             "CLAYTON, single; and RUTH CLAYTON PATE, joined by her husband ORVILLE "
             "PATE, being all the heirs of Roy N. Clayton deceased, for Three "
             "Thousand Dollars ($3,000.00) paid by FRANK T. MOSELEY, have GRANTED "
             "unto said FRANK T. MOSELEY the E/2 of Section 6, Block 45, T&P Ry. "
             "Co. Survey, A-1247, Reeves County, Texas, including the surface and "
             "three-fourths (3/4) of all minerals."),
            ("TO HAVE AND TO HOLD unto the said Grantee, his heirs and assigns; "
             "and Grantors bind themselves to WARRANT AND FOREVER DEFEND the same."),
            "Witness our hands this 20th day of August, A.D. 1920.",
            "CLARA B. CLAYTON  CECIL R. CLAYTON  WARREN T. CLAYTON  RUTH CLAYTON PATE  ORVILLE PATE",
        ],
        stamp=dict(rd="August 26, 1920", vol="18", page="440", clerk="W. C. Travers"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Clara B. Clayton, Cecil R. Clayton, Warren T. Clayton, Ruth Clayton Pate, and Orville Pate (heirs of Roy N. Clayton)",
                GRANTEE="Frank T. Moseley",
                DATE_EXECUTED="August 20, 1920", DATE_RECORDED="August 26, 1920",
                RECORDING_REF="Vol. 18, Page 440"),
    ),
    # ══ 1923–1932: medium typed era ══════════════════════════════════════════
    dict(
        file="14_wd_moseley_whitfield", style="medium_typed",
        title="WARRANTY DEED",
        body=[
            "THE STATE OF TEXAS  }  COUNTY OF REEVES  }  KNOW ALL MEN:",
            ("That FRANK T. MOSELEY and wife, EUNICE R. MOSELEY, for and in "
             "consideration of Five Thousand Five Hundred Dollars ($5,500.00) "
             "paid by JAMES R. WHITFIELD, have GRANTED, SOLD AND CONVEYED unto "
             "said JAMES R. WHITFIELD " + LEGAL + "."),
            ("This conveyance includes both the surface and all mineral interests "
             "owned by Grantors, subject to the 1/4 mineral interest previously "
             "conveyed to Southwestern Mineral Trust."),
            ("TO HAVE AND TO HOLD unto the said Grantee, his heirs and assigns; "
             "and Grantors bind themselves to WARRANT AND FOREVER DEFEND the same."),
            "Witness our hands this 7th day of April, A.D. 1923.",
            "FRANK T. MOSELEY            EUNICE R. MOSELEY",
        ],
        stamp=dict(rd="April 12, 1923", vol="20", page="67", clerk="W. C. Travers"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Frank T. Moseley and wife Eunice R. Moseley",
                GRANTEE="James R. Whitfield",
                DATE_EXECUTED="April 7, 1923", DATE_RECORDED="April 12, 1923",
                RECORDING_REF="Vol. 20, Page 67"),
    ),
    dict(
        file="15_dt_whitfield_csb", style="medium_typed",
        title="DEED OF TRUST",
        body=[
            "THE STATE OF TEXAS, COUNTY OF REEVES.",
            ("JAMES R. WHITFIELD (Grantor), to secure one promissory note of even "
             "date in the principal sum of THREE THOUSAND DOLLARS ($3,000.00), "
             "payable to CITIZENS STATE BANK OF PECOS, has GRANTED unto HENRY W. "
             "DALE, TRUSTEE, " + LEGAL + "."),
            ("Note bears interest at seven percent (7%) per annum, due in four "
             "annual installments. Default authorizes Trustee to sell at public "
             "auction after proper notice."),
            "Witness my hand this 15th day of April, A.D. 1923.",
            "JAMES R. WHITFIELD",
        ],
        stamp=dict(rd="April 18, 1923", vol="20", page="88", clerk="W. C. Travers"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="James R. Whitfield",
                GRANTEE="Henry W. Dale, Trustee (for Citizens State Bank of Pecos)",
                DATE_EXECUTED="April 15, 1923", DATE_RECORDED="April 18, 1923",
                RECORDING_REF="Vol. 20, Page 88"),
    ),
    dict(
        file="16_ogl_whitfield_texascrude", style="medium_typed",
        title="OIL AND GAS LEASE",
        body=[
            ("THIS LEASE, between JAMES R. WHITFIELD and SOUTHWESTERN MINERAL "
             "TRUST (Lessors), and TEXAS CRUDE INC. (Lessee):"),
            ("Lessors grant and let unto Lessee for the purpose of drilling for "
             "and producing oil and gas: " + LEGAL + "."),
            ("Term: primary term of three (3) years, and thereafter while "
             "production continues. Royalty: one-eighth (1/8) of oil; 1/8 of "
             "gas value at the wellhead. (Producers 88 form.)"),
            "Witness our hands this 1st day of July, A.D. 1924.",
            "JAMES R. WHITFIELD    SOUTHWESTERN MINERAL TRUST, by its Trustee",
        ],
        stamp=dict(rd="July 7, 1924", vol="21", page="310", clerk="W. C. Travers"),
        deg=["1st day of July, A.D. 1924"], deg_stamp=False,
        gt=dict(GRANTOR="James R. Whitfield and Southwestern Mineral Trust (Lessors)",
                GRANTEE="Texas Crude Inc. (Lessee)",
                DATE_EXECUTED=None,  # degraded
                DATE_RECORDED="July 7, 1924",
                RECORDING_REF="Vol. 21, Page 310"),
    ),
    dict(
        file="17_partial_release_texascrude", style="medium_typed",
        title="PARTIAL RELEASE OF OIL AND GAS LEASE",
        body=[
            ("TEXAS CRUDE INC., present Lessee under Oil and Gas Lease recorded "
             "Vol. 21, Page 310, Reeves County, Texas, does hereby RELEASE and "
             "SURRENDER all rights under said lease insofar as it covers the West "
             "Half (W/2) of Section 6, Block 45, T&P Ry. Co. Survey, A-1247, "
             "Reeves County, Texas."),
            ("Said lease shall continue in full force and effect as to the East "
             "Half (E/2) of said section."),
            "Witness its hand this 15th day of March, A.D. 1925.",
            "TEXAS CRUDE INC.",
            "By: L. T. Perkins, President",
        ],
        stamp=dict(rd="March 20, 1925", vol="21", page="588", clerk="W. C. Travers"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Texas Crude Inc.",
                GRANTEE="present owners (partial release — W/2 only)",
                DATE_EXECUTED="March 15, 1925", DATE_RECORDED="March 20, 1925",
                RECORDING_REF="Vol. 21, Page 588"),
    ),
    dict(
        file="18_release_dt_csb", style="medium_typed",
        title="RELEASE OF DEED OF TRUST",
        body=[
            ("WHEREAS, by Deed of Trust dated April 15, 1923, recorded Vol. 20, "
             "Page 88, James R. Whitfield conveyed land to Henry W. Dale, Trustee, "
             "to secure a note to CITIZENS STATE BANK OF PECOS; and"),
            ("WHEREAS said note has been fully paid and satisfied; NOW THEREFORE, "
             "CITIZENS STATE BANK OF PECOS does hereby RELEASE AND DISCHARGE the "
             "lien created by said Deed of Trust upon " + LEGAL_S + "."),
            "Witness its hand this 10th day of November, A.D. 1926.",
            "CITIZENS STATE BANK OF PECOS",
            "By: A. D. Fenton, Cashier",
        ],
        stamp=dict(rd="November 15, 1926", vol="23", page="101", clerk="W. C. Travers"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Citizens State Bank of Pecos",
                GRANTEE="James R. Whitfield (releases lien)",
                DATE_EXECUTED="November 10, 1926", DATE_RECORDED="November 15, 1926",
                RECORDING_REF="Vol. 23, Page 101"),
    ),
    dict(
        file="19_correction_wd_moseley_whitfield", style="medium_typed",
        title="CORRECTION WARRANTY DEED",
        body=[
            ("WHEREAS, by Warranty Deed dated April 7, 1923, recorded Vol. 20, "
             "Page 67, Frank T. Moseley conveyed land to James R. Whitfield, but "
             "said deed erroneously described the property as being in 'Block 44' "
             "instead of 'Block 45'; NOW THEREFORE, this Correction Deed is "
             "executed to correct said error."),
            ("FRANK T. MOSELEY and wife, EUNICE R. MOSELEY, do hereby CONFIRM and "
             "CONVEY unto JAMES R. WHITFIELD the land correctly described as "
             + LEGAL + ". All other terms of said original deed remain in full "
             "force and effect."),
            "Witness our hands this 3rd day of August, A.D. 1926.",
            "FRANK T. MOSELEY            EUNICE R. MOSELEY",
        ],
        stamp=dict(rd="August 8, 1926", vol="23", page="44", clerk="W. C. Travers"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Frank T. Moseley and wife Eunice R. Moseley",
                GRANTEE="James R. Whitfield",
                DATE_EXECUTED="August 3, 1926", DATE_RECORDED="August 8, 1926",
                RECORDING_REF="Vol. 23, Page 44"),
    ),
    dict(
        file="20_npri_whitfield_pearl", style="medium_typed",
        title="ROYALTY DEED\n(NON-PARTICIPATING)",
        body=[
            "THE STATE OF TEXAS  }  COUNTY OF REEVES  }  KNOW ALL MEN:",
            ("That JAMES R. WHITFIELD, for and in consideration of love and "
             "affection and Ten Dollars ($10.00) to him paid by PEARL M. "
             "WHITFIELD, has GRANTED unto said PEARL M. WHITFIELD an undivided "
             "ONE-SIXTEENTH (1/16) non-participating royalty interest in and to "
             "all oil, gas and other minerals produced from " + LEGAL_S + "."),
            ("This is a royalty interest only; Grantee has no right to execute "
             "leases, receive bonus or delay rentals, nor any right of ingress "
             "or egress. The interest conveys 1/16 of 8/8ths of production."),
            "Witness my hand this 12th day of December, A.D. 1927.",
            "JAMES R. WHITFIELD",
        ],
        stamp=dict(rd="December 17, 1927", vol="24", page="290", clerk="W. C. Travers"),
        deg=["ONE-SIXTEENTH (1/16)"], deg_stamp=False,
        gt=dict(GRANTOR="James R. Whitfield",
                GRANTEE="Pearl M. Whitfield",
                DATE_EXECUTED="December 12, 1927", DATE_RECORDED="December 17, 1927",
                RECORDING_REF="Vol. 24, Page 290"),
    ),
    dict(
        file="21_mineral_deed_whitfield_pmc", style="medium_typed",
        title="MINERAL DEED",
        body=[
            "THE STATE OF TEXAS  }  COUNTY OF REEVES  }  KNOW ALL MEN:",
            ("That JAMES R. WHITFIELD, for Eight Hundred Dollars ($800.00) paid "
             "by PERMIAN MINERAL CORPORATION, has GRANTED unto said PERMIAN "
             "MINERAL CORPORATION an undivided ONE-EIGHTH (1/8) of all oil, gas "
             "and other minerals in, on and under " + LEGAL + "."),
            ("This conveyance is subject to the 1/16 NPRI previously conveyed to "
             "Pearl M. Whitfield and is a participating mineral interest carrying "
             "the right to lease and collect bonuses and rentals."),
            "Witness my hand this 20th day of May, A.D. 1928.",
            "JAMES R. WHITFIELD",
        ],
        stamp=dict(rd="May 24, 1928", vol="25", page="170", clerk="W. C. Travers"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="James R. Whitfield",
                GRANTEE="Permian Mineral Corporation",
                DATE_EXECUTED="May 20, 1928", DATE_RECORDED="May 24, 1928",
                RECORDING_REF="Vol. 25, Page 170"),
    ),
    dict(
        file="22_ogl_whitfield_biglake", style="medium_typed",
        title="OIL AND GAS LEASE",
        body=[
            ("THIS LEASE, between JAMES R. WHITFIELD, PEARL M. WHITFIELD, "
             "PERMIAN MINERAL CORPORATION, and SOUTHWESTERN MINERAL TRUST "
             "(Lessors), and BIG LAKE OIL COMPANY (Lessee):"),
            ("Lessors grant to Lessee the exclusive right to drill for and "
             "produce oil and gas from: " + LEGAL + "."),
            ("Term: primary term of THREE (3) years and as long thereafter as "
             "oil or gas is produced. Royalty: 1/8 of oil; 1/8 of gas at the "
             "wellhead. (Producers 88 — Texas form with pooling clause.)"),
            "Witness our hands this 3rd day of January, A.D. 1929.",
            "JAMES R. WHITFIELD  PEARL M. WHITFIELD  PERMIAN MINERAL CORP.  SW MINERAL TRUST",
        ],
        stamp=dict(rd="January 8, 1929", vol="26", page="44", clerk="W. C. Travers"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="James R. Whitfield, Pearl M. Whitfield, Permian Mineral Corporation, and Southwestern Mineral Trust (Lessors)",
                GRANTEE="Big Lake Oil Company (Lessee)",
                DATE_EXECUTED="January 3, 1929", DATE_RECORDED="January 8, 1929",
                RECORDING_REF="Vol. 26, Page 44"),
    ),
    dict(
        file="23_assign_ogl_biglake_humble", style="medium_typed",
        title="ASSIGNMENT OF OIL AND GAS LEASE",
        body=[
            ("BIG LAKE OIL COMPANY (Assignor), for valuable consideration, does "
             "hereby ASSIGN and TRANSFER unto HUMBLE OIL AND REFINING COMPANY "
             "(Assignee) all of its right, title and interest in and to the Oil "
             "and Gas Lease dated January 3, 1929, recorded Vol. 26, Page 44, "
             "Reeves County, Texas, covering " + LEGAL_S + "."),
            ("This assignment is made subject to all terms of said lease and the "
             "royalties payable thereunder."),
            "Witness its hand this 1st day of September, A.D. 1930.",
            "BIG LAKE OIL COMPANY",
            "By: P. K. Donaldson, Vice-President",
        ],
        stamp=dict(rd="September 5, 1930", vol="28", page="214", clerk="W. C. Travers"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Big Lake Oil Company",
                GRANTEE="Humble Oil and Refining Company",
                DATE_EXECUTED="September 1, 1930", DATE_RECORDED="September 5, 1930",
                RECORDING_REF="Vol. 28, Page 214"),
    ),
    dict(
        file="24_wd_whitfield_bauer", style="medium_typed",
        title="WARRANTY DEED",
        body=[
            "THE STATE OF TEXAS  }  COUNTY OF REEVES  }  KNOW ALL MEN:",
            ("That JAMES R. WHITFIELD and wife, PEARL M. WHITFIELD, for and in "
             "consideration of Eight Thousand Dollars ($8,000.00) paid by "
             "RAYMOND G. BAUER, have GRANTED, SOLD AND CONVEYED unto said "
             "RAYMOND G. BAUER " + LEGAL + ", including the surface and all "
             "mineral interests owned by Grantors, subject to the 1/8 interest "
             "in Permian Mineral Corporation."),
            ("TO HAVE AND TO HOLD unto the said Grantee, his heirs and assigns; "
             "Grantors bind themselves to WARRANT AND FOREVER DEFEND the same."),
            "Witness our hands this 14th day of March, A.D. 1931.",
            "JAMES R. WHITFIELD          PEARL M. WHITFIELD",
        ],
        stamp=dict(rd="March 18, 1931", vol="29", page="511", clerk="W. C. Travers"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="James R. Whitfield and wife Pearl M. Whitfield",
                GRANTEE="Raymond G. Bauer",
                DATE_EXECUTED="March 14, 1931", DATE_RECORDED="March 18, 1931",
                RECORDING_REF="Vol. 29, Page 511"),
    ),
    dict(
        file="25_release_ogl_texascrude_e2", style="medium_typed",
        title="RELEASE OF OIL AND GAS LEASE",
        body=[
            ("TEXAS CRUDE INC., present Lessee under Oil and Gas Lease recorded "
             "Vol. 21, Page 310 (partial release of W/2 recorded Vol. 21, Page "
             "588), for valuable consideration, does hereby RELEASE and SURRENDER "
             "all remaining rights under said lease covering the E/2 of Section 6, "
             "Block 45, T&P Ry. Co. Survey, A-1247, Reeves County, Texas."),
            "Said lease is hereby declared terminated in its entirety.",
            "Witness its hand this 22nd day of June, A.D. 1931.",
            "TEXAS CRUDE INC.",
            "By: L. T. Perkins, President",
        ],
        stamp=dict(rd="June 27, 1931", vol="30", page="88", clerk="W. C. Travers"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Texas Crude Inc.",
                GRANTEE="present owners (releases E/2 lease)",
                DATE_EXECUTED="June 22, 1931", DATE_RECORDED="June 27, 1931",
                RECORDING_REF="Vol. 30, Page 88"),
    ),
    dict(
        file="26_dt_bauer_fnbp", style="medium_typed",
        title="DEED OF TRUST",
        body=[
            "THE STATE OF TEXAS, COUNTY OF REEVES.",
            ("RAYMOND G. BAUER (Grantor), to secure a promissory note of even "
             "date in the sum of FIVE THOUSAND AND NO/100 DOLLARS ($5,000.00), "
             "payable to THE FIRST NATIONAL BANK OF PECOS, has GRANTED unto "
             "GEORGE W. LANCE, TRUSTEE, " + LEGAL + "."),
            ("Note bears interest at six percent (6%) per annum, due in five "
             "annual installments beginning March 20, 1932. Default authorizes "
             "Trustee to sell at public auction."),
            "Witness my hand this 20th day of March, A.D. 1931.",
            "RAYMOND G. BAUER",
        ],
        stamp=dict(rd="March 24, 1931", vol="29", page="540", clerk="W. C. Travers"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Raymond G. Bauer",
                GRANTEE="George W. Lance, Trustee (for The First National Bank of Pecos)",
                DATE_EXECUTED="March 20, 1931", DATE_RECORDED="March 24, 1931",
                RECORDING_REF="Vol. 29, Page 540"),
    ),
    dict(
        file="27_release_ogl_humble", style="medium_typed",
        title="RELEASE OF OIL AND GAS LEASE",
        body=[
            ("HUMBLE OIL AND REFINING COMPANY, as Lessee under Oil and Gas Lease "
             "recorded Vol. 26, Page 44 (as assigned Vol. 28, Page 214), does "
             "hereby RELEASE, SURRENDER and QUITCLAIM unto the present owners all "
             "rights under said lease covering " + LEGAL_S + "."),
            "Said lease is declared cancelled and of no further force or effect.",
            "Witness its hand this 30th day of June, A.D. 1933.",
            "HUMBLE OIL AND REFINING COMPANY",
            "By: T. J. McLemore, Manager, Reeves County District",
        ],
        stamp=dict(rd="July 5, 1933", vol="33", page="201", clerk="W. C. Travers"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Humble Oil and Refining Company",
                GRANTEE="present owners (releases lease)",
                DATE_EXECUTED="June 30, 1933", DATE_RECORDED="July 5, 1933",
                RECORDING_REF="Vol. 33, Page 201"),
    ),
    dict(
        file="28_tax_lien_reeves_county", style="medium_typed",
        title="TAX LIEN NOTICE\nREEVES COUNTY, TEXAS",
        body=[
            ("NOTICE IS HEREBY GIVEN that Reeves County, Texas has a lien "
             "against " + LEGAL_S + ", owned by RAYMOND G. BAUER, for "
             "delinquent ad valorem taxes for the years 1932 and 1933, in the "
             "total sum of Ninety-Four and 50/100 Dollars ($94.50), plus "
             "penalties and interest as provided by law."),
            ("This lien is prior and superior to all other liens, claims, and "
             "encumbrances against said property except for prior year taxes."),
            "Reeves County, Texas",
            "By: E. F. Hodges, Tax Collector",
        ],
        stamp=dict(rd="January 5, 1934", vol="34", page="12",
                   instr="1934-0044", clerk="J. A. Kilpatrick"),
        deg=[], deg_stamp=True,
        gt=dict(GRANTOR="Reeves County, Texas (Tax Collector)",
                GRANTEE="not applicable (tax lien notice)",
                DATE_EXECUTED="January 5, 1934",
                DATE_RECORDED=None,  # degraded stamp
                RECORDING_REF=None),  # degraded stamp
    ),
    dict(
        file="29_release_tax_lien", style="medium_typed",
        title="RELEASE OF TAX LIEN",
        body=[
            ("REEVES COUNTY, TEXAS hereby certifies that the delinquent ad "
             "valorem tax lien recorded Vol. 34, Page 12 against property owned "
             "by Raymond G. Bauer, being " + LEGAL_S + ", has been fully paid "
             "and satisfied."),
            ("Said tax lien is hereby RELEASED AND DISCHARGED. This release is "
             "granted pursuant to payment of all principal, penalties and "
             "interest due as required by law."),
            "Witness its seal this 2nd day of March, A.D. 1935.",
            "REEVES COUNTY, TEXAS",
            "By: E. F. Hodges, Tax Collector",
        ],
        stamp=dict(rd="March 6, 1935", vol="35", page="44",
                   instr="1935-0312", clerk="J. A. Kilpatrick"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Reeves County, Texas",
                GRANTEE="Raymond G. Bauer (releases tax lien)",
                DATE_EXECUTED="March 2, 1935", DATE_RECORDED="March 6, 1935",
                RECORDING_REF="Vol. 35, Page 44"),
    ),
    dict(
        file="30_ogl_bauer_standard_oil", style="medium_typed",
        title="OIL AND GAS LEASE",
        body=[
            ("THIS LEASE between RAYMOND G. BAUER and PERMIAN MINERAL "
             "CORPORATION (Lessors), and STANDARD OIL COMPANY OF TEXAS "
             "(Lessee):"),
            ("Lessors grant Lessee the exclusive right to drill for and produce "
             "oil and gas from " + LEGAL + ". Primary term: three (3) years from "
             "this date. Royalty: 1/8 of oil; 1/8 of gas value at wellhead. "
             "(Producers 88 form, with pooling authorization.)"),
            "Witness our hands this 1st day of February, A.D. 1936.",
            "RAYMOND G. BAUER       PERMIAN MINERAL CORPORATION, by its President",
        ],
        stamp=dict(rd="February 5, 1936", vol="36", page="277",
                   instr="1936-0488", clerk="J. A. Kilpatrick"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Raymond G. Bauer and Permian Mineral Corporation (Lessors)",
                GRANTEE="Standard Oil Company of Texas (Lessee)",
                DATE_EXECUTED="February 1, 1936", DATE_RECORDED="February 5, 1936",
                RECORDING_REF="Vol. 36, Page 277"),
    ),
    dict(
        file="31_assign_ogl_standard_atlantic", style="medium_typed",
        title="ASSIGNMENT OF OIL AND GAS LEASE",
        body=[
            ("STANDARD OIL COMPANY OF TEXAS (Assignor), for Ten Dollars ($10.00) "
             "and other valuable consideration, does ASSIGN and TRANSFER unto "
             "ATLANTIC REFINING COMPANY (Assignee) all of its right, title and "
             "interest in the Oil and Gas Lease dated February 1, 1936, recorded "
             "Vol. 36, Page 277, covering " + LEGAL_S + "."),
            ("This assignment is subject to all terms and royalties of said "
             "lease. Assignee assumes all obligations of Lessee thereunder."),
            "Witness its hand this 15th day of July, A.D. 1937.",
            "STANDARD OIL COMPANY OF TEXAS",
            "By: H. C. Beall, Vice-President",
        ],
        stamp=dict(rd="July 19, 1937", vol="38", page="133",
                   instr="1937-2201", clerk="J. A. Kilpatrick"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Standard Oil Company of Texas",
                GRANTEE="Atlantic Refining Company",
                DATE_EXECUTED="July 15, 1937", DATE_RECORDED="July 19, 1937",
                RECORDING_REF="Vol. 38, Page 133"),
    ),
    dict(
        file="32_release_dt_fnbp", style="medium_typed",
        title="RELEASE OF DEED OF TRUST",
        body=[
            ("WHEREAS, by Deed of Trust dated March 20, 1931, recorded Vol. 29, "
             "Page 540, Raymond G. Bauer conveyed land to George W. Lance, "
             "Trustee, to secure a note to THE FIRST NATIONAL BANK OF PECOS; "
             "and WHEREAS said note and all interest have been fully paid;"),
            ("NOW THEREFORE, THE FIRST NATIONAL BANK OF PECOS does hereby "
             "RELEASE AND DISCHARGE the lien upon " + LEGAL_S + "."),
            "Witness its hand this 8th day of April, A.D. 1938.",
            "THE FIRST NATIONAL BANK OF PECOS",
            "By: C. R. Hutchins, President",
        ],
        stamp=dict(rd="April 12, 1938", vol="39", page="88",
                   instr="1938-1100", clerk="J. A. Kilpatrick"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="The First National Bank of Pecos",
                GRANTEE="Raymond G. Bauer (releases lien)",
                DATE_EXECUTED="April 8, 1938", DATE_RECORDED="April 12, 1938",
                RECORDING_REF="Vol. 39, Page 88"),
    ),
    dict(
        file="33_wd_bauer_sutton", style="medium_typed",
        title="WARRANTY DEED",
        body=[
            "THE STATE OF TEXAS  }  COUNTY OF REEVES  }  KNOW ALL MEN:",
            ("That RAYMOND G. BAUER and wife, DOROTHY L. BAUER, for and in "
             "consideration of Twelve Thousand Dollars ($12,000.00) paid by "
             "SUTTON LAND COMPANY, a Texas corporation, have GRANTED, SOLD AND "
             "CONVEYED unto said SUTTON LAND COMPANY " + LEGAL + ", including "
             "all mineral interests owned by Grantors, subject to the 1/8 "
             "interest in Permian Mineral Corporation."),
            ("TO HAVE AND TO HOLD unto the said Grantee, its successors and "
             "assigns; and Grantors bind themselves to WARRANT AND FOREVER "
             "DEFEND the same."),
            "Witness our hands this 10th day of January, A.D. 1940.",
            "RAYMOND G. BAUER            DOROTHY L. BAUER",
        ],
        stamp=dict(rd="January 15, 1940", vol="42", page="344",
                   instr="1940-0180", clerk="J. A. Kilpatrick"),
        deg=["SUTTON LAND COMPANY"], deg_stamp=False,
        gt=dict(GRANTOR="Raymond G. Bauer and wife Dorothy L. Bauer",
                GRANTEE=None,  # degraded
                DATE_EXECUTED="January 10, 1940", DATE_RECORDED="January 15, 1940",
                RECORDING_REF="Vol. 42, Page 344"),
    ),
    dict(
        file="34_assign_ogl_atlantic_gulf", style="medium_typed",
        title="ASSIGNMENT OF OIL AND GAS LEASE",
        body=[
            ("ATLANTIC REFINING COMPANY (Assignor), for valuable consideration, "
             "does ASSIGN and TRANSFER unto GULF PRODUCTION CORPORATION (Assignee) "
             "all of its right, title and interest in the Oil and Gas Lease dated "
             "February 1, 1936, recorded Vol. 36, Page 277 (as assigned Vol. 38, "
             "Page 133), covering " + LEGAL_S + "."),
            ("This assignment includes all equipment and well fixtures. Assignee "
             "assumes all obligations of Lessee under said lease."),
            "Witness its hand this 5th day of March, A.D. 1941.",
            "ATLANTIC REFINING COMPANY",
            "By: W. F. Storey, Land Manager",
        ],
        stamp=dict(rd="March 10, 1941", vol="43", page="218",
                   instr="1941-0744", clerk="J. A. Kilpatrick"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Atlantic Refining Company",
                GRANTEE="Gulf Production Corporation",
                DATE_EXECUTED="March 5, 1941", DATE_RECORDED="March 10, 1941",
                RECORDING_REF="Vol. 43, Page 218"),
    ),
    dict(
        file="35_ratification_ogl_sutton", style="medium_typed",
        title="RATIFICATION OF OIL AND GAS LEASE",
        body=[
            ("SUTTON LAND COMPANY, a Texas corporation, as present surface and "
             "mineral owner of " + LEGAL_S + ", for Ten Dollars ($10.00) and "
             "other valuable consideration, does hereby RATIFY, CONFIRM and "
             "ADOPT the Oil and Gas Lease dated February 1, 1936, recorded "
             "Vol. 36, Page 277 (as subsequently assigned), covering said land."),
            ("Sutton Land Company was not a party to said lease but hereby "
             "ratifies same as if an original party thereto, effective as of "
             "the date of acquisition of its interest."),
            "Witness its hand this 20th day of September, A.D. 1942.",
            "SUTTON LAND COMPANY",
            "By: W. D. Sutton, President",
        ],
        stamp=dict(rd="September 25, 1942", vol="45", page="500",
                   instr="1942-3311", clerk="J. A. Kilpatrick"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Sutton Land Company",
                GRANTEE="Gulf Production Corporation (ratification of lease)",
                DATE_EXECUTED="September 20, 1942", DATE_RECORDED="September 25, 1942",
                RECORDING_REF="Vol. 45, Page 500"),
    ),
    dict(
        file="36_affidavit_heirship_bauer", style="medium_typed",
        title="AFFIDAVIT OF HEIRSHIP\n(ESTATE OF RAYMOND G. BAUER)",
        body=[
            "THE STATE OF TEXAS  }  COUNTY OF REEVES  }",
            ("BEFORE ME personally appeared DOROTHY L. BAUER, who being duly "
             "sworn says: That RAYMOND G. BAUER died intestate in Reeves County, "
             "Texas on November 14, 1942; that no administration is pending or "
             "necessary; that he owned no real property at the time of death as "
             "said property had been sold to Sutton Land Company by deed dated "
             "January 10, 1940."),
            ("Surviving heirs: widow DOROTHY L. BAUER; son RAYMOND G. BAUER JR.; "
             "and daughter PATRICIA BAUER HOLLIS, joined by her husband GERALD "
             "HOLLIS. Said heirs have no interest in the Reeves County property."),
            "DOROTHY L. BAUER, Affiant",
            "Sworn before me this 1st day of February, A.D. 1943.",
        ],
        stamp=dict(rd="February 4, 1943", vol="46", page="10",
                   instr="1943-0088", clerk="J. A. Kilpatrick"),
        deg=["PATRICIA BAUER HOLLIS"], deg_stamp=False,
        gt=dict(GRANTOR="Dorothy L. Bauer (Affiant)",
                GRANTEE="Heirs: Dorothy L. Bauer, Raymond G. Bauer Jr., Patricia Bauer Hollis",
                DATE_EXECUTED="February 1, 1943", DATE_RECORDED="February 4, 1943",
                RECORDING_REF="Vol. 46, Page 10"),
    ),
    # ══ 1943–1962: clean typed era ══════════════════════════════════════════
    dict(
        file="37_release_ogl_gulf_production", style="clean_typed",
        title="RELEASE OF OIL AND GAS LEASE",
        body=[
            ("GULF PRODUCTION CORPORATION, Lessee under Oil and Gas Lease "
             "recorded Vol. 36, Page 277 (as assigned Vol. 43, Page 218), "
             "and ratified Vol. 45, Page 500, for valuable consideration, does "
             "hereby RELEASE, SURRENDER and QUITCLAIM unto the present owners "
             "all of its right, title and interest under said lease covering "
             + LEGAL + "."),
            "Said lease is declared cancelled and of no further force or effect.",
            "Witness its hand this 15th day of August, A.D. 1944.",
            "GULF PRODUCTION CORPORATION",
            "By: B. T. Williamson, Division Manager",
        ],
        stamp=dict(rd="August 19, 1944", vol="47", page="388",
                   instr="1944-2810", clerk="J. A. Kilpatrick"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Gulf Production Corporation",
                GRANTEE="present owners (releases lease)",
                DATE_EXECUTED="August 15, 1944", DATE_RECORDED="August 19, 1944",
                RECORDING_REF="Vol. 47, Page 388"),
    ),
    dict(
        file="38_ogl_sutton_western_gas", style="clean_typed",
        title="OIL AND GAS LEASE",
        body=[
            ("THIS LEASE between SUTTON LAND COMPANY and PERMIAN MINERAL "
             "CORPORATION (Lessors), and WESTERN GAS CORPORATION (Lessee):"),
            ("Lessors grant Lessee the exclusive right to drill for and produce "
             "oil and gas from " + LEGAL + ". Primary term: five (5) years from "
             "this date. Royalty: 1/8 of oil; 1/8 of gas at the wellhead. "
             "(Producers 88 form with pooling clause.)"),
            ("Delay rental: One Dollar ($1.00) per acre per year. Shut-in "
             "royalty: One Dollar ($1.00) per acre per year."),
            "Witness our hands this 1st day of March, A.D. 1945.",
            "SUTTON LAND COMPANY, by W. D. Sutton, President",
            "PERMIAN MINERAL CORPORATION, by its President",
        ],
        stamp=dict(rd="March 6, 1945", vol="48", page="110",
                   instr="1945-0744", clerk="J. A. Kilpatrick"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Sutton Land Company and Permian Mineral Corporation (Lessors)",
                GRANTEE="Western Gas Corporation (Lessee)",
                DATE_EXECUTED="March 1, 1945", DATE_RECORDED="March 6, 1945",
                RECORDING_REF="Vol. 48, Page 110"),
    ),
    dict(
        file="39_subordination_sutton_western", style="clean_typed",
        title="SUBORDINATION AGREEMENT",
        body=[
            ("THIS AGREEMENT between SUTTON LAND COMPANY (Landowner), WESTERN "
             "GAS CORPORATION (Lessee), and CONTINENTAL NATIONAL BANK OF FORT "
             "WORTH (Mortgagee):"),
            ("Mortgagee, holder of a deed of trust lien against Sutton Land "
             "Company's interest in " + LEGAL_S + ", does hereby agree that "
             "its lien shall be subordinate and inferior to the Oil and Gas "
             "Lease dated March 1, 1945, recorded Vol. 48, Page 110."),
            ("This subordination is limited to the leasehold interest only and "
             "does not affect Mortgagee's rights in the mineral interest."),
            "Witness our hands this 10th day of November, A.D. 1946.",
            "SUTTON LAND CO.    WESTERN GAS CORP.    CONTINENTAL NATIONAL BANK OF FT. WORTH",
        ],
        stamp=dict(rd="November 14, 1946", vol="50", page="222",
                   instr="1946-4401", clerk="J. A. Kilpatrick"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Sutton Land Company, Western Gas Corporation, and Continental National Bank of Fort Worth",
                GRANTEE="not applicable (subordination agreement)",
                DATE_EXECUTED="November 10, 1946", DATE_RECORDED="November 14, 1946",
                RECORDING_REF="Vol. 50, Page 222"),
    ),
    dict(
        file="40_assign_ogl_western_lonestar", style="clean_typed",
        title="ASSIGNMENT OF OIL AND GAS LEASE",
        body=[
            ("WESTERN GAS CORPORATION (Assignor), for valuable consideration, "
             "does ASSIGN and TRANSFER unto LONE STAR PRODUCING COMPANY "
             "(Assignee) all of its right, title and interest in the Oil and "
             "Gas Lease dated March 1, 1945, recorded Vol. 48, Page 110, "
             "covering " + LEGAL_S + "."),
            ("Assignee assumes all obligations of Lessee and shall pay all "
             "royalties falling due after the date hereof."),
            "Witness its hand this 22nd day of April, A.D. 1947.",
            "WESTERN GAS CORPORATION",
            "By: P. H. Adkins, President",
        ],
        stamp=dict(rd="April 26, 1947", vol="51", page="404",
                   instr="1947-1688", clerk="J. A. Kilpatrick"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Western Gas Corporation",
                GRANTEE="Lone Star Producing Company",
                DATE_EXECUTED="April 22, 1947", DATE_RECORDED="April 26, 1947",
                RECORDING_REF="Vol. 51, Page 404"),
    ),
    dict(
        file="41_mineral_deed_sutton_swminerals", style="clean_typed",
        title="MINERAL DEED",
        body=[
            "THE STATE OF TEXAS  }  COUNTY OF REEVES  }  KNOW ALL MEN:",
            ("That SUTTON LAND COMPANY, for and in consideration of One Thousand "
             "Dollars ($1,000.00) paid by SOUTHWEST MINERALS LIMITED, does "
             "hereby GRANT, SELL AND CONVEY unto said SOUTHWEST MINERALS LIMITED "
             "an undivided ONE-SIXTEENTH (1/16) interest in and to all oil, gas "
             "and other minerals in, on and under " + LEGAL + "."),
            ("This is a participating mineral interest carrying the right to "
             "execute leases and collect bonuses and rentals in proportion to the "
             "interest conveyed."),
            "Witness its hand this 14th day of June, A.D. 1949.",
            "SUTTON LAND COMPANY",
            "By: W. D. Sutton, President",
        ],
        stamp=dict(rd="June 18, 1949", vol="55", page="166",
                   instr="1949-2240", clerk="J. A. Kilpatrick"),
        deg=["ONE-SIXTEENTH (1/16)"], deg_stamp=False,
        gt=dict(GRANTOR="Sutton Land Company",
                GRANTEE="Southwest Minerals Limited",
                DATE_EXECUTED="June 14, 1949", DATE_RECORDED="June 18, 1949",
                RECORDING_REF="Vol. 55, Page 166"),
    ),
    dict(
        file="42_wd_sutton_webb", style="clean_typed",
        title="WARRANTY DEED",
        body=[
            "THE STATE OF TEXAS  }  COUNTY OF REEVES  }  KNOW ALL MEN:",
            ("That SUTTON LAND COMPANY, a Texas corporation, for and in "
             "consideration of Eighteen Thousand Dollars ($18,000.00) paid by "
             "HARLAN T. WEBB, has GRANTED, SOLD AND CONVEYED unto said HARLAN "
             "T. WEBB " + LEGAL + ", including the surface and all mineral "
             "interests owned by Sutton Land Company, subject to the interests "
             "in Permian Mineral Corporation and Southwest Minerals Limited."),
            ("TO HAVE AND TO HOLD unto the said Grantee, his heirs and assigns; "
             "and Grantor binds itself to WARRANT AND FOREVER DEFEND the same."),
            "Witness its hand this 8th day of January, A.D. 1950.",
            "SUTTON LAND COMPANY",
            "By: W. D. Sutton, President",
        ],
        stamp=dict(rd="January 12, 1950", vol="57", page="44",
                   instr="1950-0122", clerk="R. E. Holcomb"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Sutton Land Company",
                GRANTEE="Harlan T. Webb",
                DATE_EXECUTED="January 8, 1950", DATE_RECORDED="January 12, 1950",
                RECORDING_REF="Vol. 57, Page 44"),
    ),
    dict(
        file="43_dt_webb_midland_savings", style="clean_typed",
        title="DEED OF TRUST",
        body=[
            "THE STATE OF TEXAS, COUNTY OF REEVES.",
            ("HARLAN T. WEBB (Grantor), to secure a promissory note of even date "
             "in the sum of TEN THOUSAND AND NO/100 DOLLARS ($10,000.00), payable "
             "to MIDLAND NATIONAL SAVINGS ASSOCIATION, has GRANTED unto WILLIAM "
             "R. FOOTE, TRUSTEE, " + LEGAL + "."),
            ("Note bears interest at five percent (5%) per annum, due in ten "
             "annual installments beginning January 15, 1951. Default authorizes "
             "Trustee to sell at public auction after notice as required by law."),
            "Witness my hand this 15th day of January, A.D. 1950.",
            "HARLAN T. WEBB",
        ],
        stamp=dict(rd="January 19, 1950", vol="57", page="66",
                   instr="1950-0144", clerk="R. E. Holcomb"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Harlan T. Webb",
                GRANTEE="William R. Foote, Trustee (for Midland National Savings Association)",
                DATE_EXECUTED="January 15, 1950", DATE_RECORDED="January 19, 1950",
                RECORDING_REF="Vol. 57, Page 66"),
    ),
    dict(
        file="44_release_ogl_lonestar", style="clean_typed",
        title="RELEASE OF OIL AND GAS LEASE",
        body=[
            ("LONE STAR PRODUCING COMPANY, Lessee under Oil and Gas Lease "
             "recorded Vol. 48, Page 110 (as assigned Vol. 51, Page 404), "
             "does hereby RELEASE, SURRENDER and QUITCLAIM unto the present "
             "owners all rights under said lease covering " + LEGAL + "."),
            ("This release is effective as of July 11, 1952, and said lease is "
             "declared cancelled and of no further force or effect as to the "
             "above-described land."),
            "Witness its hand this 11th day of July, A.D. 1952.",
            "LONE STAR PRODUCING COMPANY",
            "By: C. J. Aldridge, Vice-President",
        ],
        stamp=dict(rd="July 15, 1952", vol="62", page="288",
                   instr="1952-2880", clerk="R. E. Holcomb"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Lone Star Producing Company",
                GRANTEE="present owners (releases lease)",
                DATE_EXECUTED="July 11, 1952", DATE_RECORDED="July 15, 1952",
                RECORDING_REF="Vol. 62, Page 288"),
    ),
    dict(
        file="45_ogl_webb_panhandle", style="clean_typed",
        title="OIL AND GAS LEASE",
        body=[
            ("THIS LEASE between HARLAN T. WEBB, SOUTHWEST MINERALS LIMITED, "
             "and PERMIAN MINERAL CORPORATION (Lessors), and PANHANDLE EASTERN "
             "PIPE LINE COMPANY (Lessee):"),
            ("Lessors grant Lessee the exclusive right to drill for and produce "
             "oil and gas from " + LEGAL + ". Primary term: THREE (3) years from "
             "this date, and as long thereafter as production continues in paying "
             "quantities. Royalty: 3/16 of oil; 3/16 of gas value."),
            "Witness our hands this 5th day of March, A.D. 1953.",
            "HARLAN T. WEBB    SOUTHWEST MINERALS LIMITED    PERMIAN MINERAL CORPORATION",
        ],
        stamp=dict(rd="March 10, 1953", vol="64", page="122",
                   instr="1953-0811", clerk="R. E. Holcomb"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Harlan T. Webb, Southwest Minerals Limited, and Permian Mineral Corporation (Lessors)",
                GRANTEE="Panhandle Eastern Pipe Line Company (Lessee)",
                DATE_EXECUTED="March 5, 1953", DATE_RECORDED="March 10, 1953",
                RECORDING_REF="Vol. 64, Page 122"),
    ),
    dict(
        file="46_pooling_agreement_webb_panhandle", style="clean_typed",
        title="POOLING AND UNITIZATION AGREEMENT",
        body=[
            ("THIS AGREEMENT between HARLAN T. WEBB (Landowner), PANHANDLE "
             "EASTERN PIPE LINE COMPANY (Lessee), and the owners of adjoining "
             "tracts as described in Exhibit A attached:"),
            ("The parties agree to pool their respective interests in the "
             "following units for the development and operation of the Brushy "
             "Draw Gas Unit, Reeves County, Texas, which unit includes "
             + LEGAL_S + " and adjacent acreage."),
            ("Each party shall receive production in proportion to its "
             "acreage in the unit. Unit operations shall constitute operations "
             "under each lease within the unit."),
            "Witness our hands this 15th day of September, A.D. 1954.",
            "HARLAN T. WEBB    PANHANDLE EASTERN PIPE LINE COMPANY",
        ],
        stamp=dict(rd="September 20, 1954", vol="68", page="300",
                   instr="1954-3441", clerk="R. E. Holcomb"),
        deg=["15th day of September, A.D. 1954"], deg_stamp=False,
        gt=dict(GRANTOR="Harlan T. Webb and Panhandle Eastern Pipe Line Company",
                GRANTEE="not applicable (pooling agreement)",
                DATE_EXECUTED=None,  # degraded
                DATE_RECORDED="September 20, 1954",
                RECORDING_REF="Vol. 68, Page 300"),
    ),
    dict(
        file="47_assign_ogl_panhandle_txpacific", style="clean_typed",
        title="ASSIGNMENT OF OIL AND GAS LEASE",
        body=[
            ("PANHANDLE EASTERN PIPE LINE COMPANY (Assignor), for valuable "
             "consideration, does ASSIGN and TRANSFER unto TEXAS PACIFIC COAL "
             "AND OIL COMPANY (Assignee) all of its right, title and interest "
             "in the Oil and Gas Lease dated March 5, 1953, recorded Vol. 64, "
             "Page 122, covering " + LEGAL_S + "."),
            ("This assignment is subject to the terms of said lease and the "
             "Pooling Agreement recorded Vol. 68, Page 300."),
            "Witness its hand this 3rd day of May, A.D. 1956.",
            "PANHANDLE EASTERN PIPE LINE COMPANY",
            "By: G. R. Enright, Land Manager",
        ],
        stamp=dict(rd="May 8, 1956", vol="72", page="188",
                   instr="1956-2014", clerk="R. E. Holcomb"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Panhandle Eastern Pipe Line Company",
                GRANTEE="Texas Pacific Coal and Oil Company",
                DATE_EXECUTED="May 3, 1956", DATE_RECORDED="May 8, 1956",
                RECORDING_REF="Vol. 72, Page 188"),
    ),
    dict(
        file="48_release_dt_midland_savings", style="clean_typed",
        title="RELEASE OF DEED OF TRUST",
        body=[
            ("WHEREAS, by Deed of Trust dated January 15, 1950, recorded Vol. "
             "57, Page 66, Harlan T. Webb conveyed land to William R. Foote, "
             "Trustee, to secure a note to MIDLAND NATIONAL SAVINGS "
             "ASSOCIATION; and WHEREAS said note has been fully paid;"),
            ("NOW THEREFORE, MIDLAND NATIONAL SAVINGS ASSOCIATION does hereby "
             "RELEASE AND DISCHARGE the lien upon " + LEGAL_S + "."),
            "Witness its hand this 20th day of February, A.D. 1958.",
            "MIDLAND NATIONAL SAVINGS ASSOCIATION",
            "By: E. W. Tate, President",
        ],
        stamp=dict(rd="February 24, 1958", vol="76", page="44",
                   instr="1958-0622", clerk="R. E. Holcomb"),
        deg=[], deg_stamp=True,
        gt=dict(GRANTOR="Midland National Savings Association",
                GRANTEE="Harlan T. Webb (releases lien)",
                DATE_EXECUTED="February 20, 1958",
                DATE_RECORDED=None,  # degraded stamp
                RECORDING_REF=None),  # degraded stamp
    ),
    dict(
        file="49_release_ogl_txpacific", style="clean_typed",
        title="RELEASE OF OIL AND GAS LEASE",
        body=[
            ("TEXAS PACIFIC COAL AND OIL COMPANY, Lessee under Oil and Gas Lease "
             "recorded Vol. 64, Page 122 (as assigned Vol. 72, Page 188), does "
             "hereby RELEASE, SURRENDER and QUITCLAIM unto the present owners all "
             "rights under said lease covering " + LEGAL + "."),
            "Said lease is declared cancelled and of no further force or effect.",
            "Witness its hand this 14th day of September, A.D. 1960.",
            "TEXAS PACIFIC COAL AND OIL COMPANY",
            "By: J. F. Cunningham, Vice-President",
        ],
        stamp=dict(rd="September 19, 1960", vol="82", page="311",
                   instr="1960-3788", clerk="R. E. Holcomb"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Texas Pacific Coal and Oil Company",
                GRANTEE="present owners (releases lease)",
                DATE_EXECUTED="September 14, 1960", DATE_RECORDED="September 19, 1960",
                RECORDING_REF="Vol. 82, Page 311"),
    ),
    dict(
        file="50_wd_webb_fletcher", style="clean_typed",
        title="WARRANTY DEED",
        body=[
            "THE STATE OF TEXAS  }  COUNTY OF REEVES  }  KNOW ALL MEN:",
            ("That HARLAN T. WEBB, a widower, for and in consideration of "
             "Twenty-Two Thousand Dollars ($22,000.00) paid by DUSTIN L. "
             "FLETCHER and wife, CAROLYN B. FLETCHER, has GRANTED, SOLD AND "
             "CONVEYED unto said DUSTIN L. FLETCHER AND CAROLYN B. FLETCHER, "
             "as joint tenants with right of survivorship, " + LEGAL + ", "
             "including all of Grantor's surface and mineral interests."),
            ("TO HAVE AND TO HOLD unto the said Grantees, their heirs and "
             "assigns; and Grantor binds himself to WARRANT AND FOREVER "
             "DEFEND the same against every person whomsoever."),
            "Witness my hand this 28th day of June, A.D. 1962.",
            "HARLAN T. WEBB",
        ],
        stamp=dict(rd="July 3, 1962", vol="88", page="210",
                   instr="1962-2744", clerk="R. E. Holcomb"),
        deg=[], deg_stamp=False,
        gt=dict(GRANTOR="Harlan T. Webb",
                GRANTEE="Dustin L. Fletcher and wife Carolyn B. Fletcher",
                DATE_EXECUTED="June 28, 1962", DATE_RECORDED="July 3, 1962",
                RECORDING_REF="Vol. 88, Page 210"),
    ),
]

# ── style parameters ─────────────────────────────────────────────────────────
STYLES = {
    "handwritten":  dict(paper=(238, 225, 195), ink=(55, 38, 14),
                         noise=0.22, rot=1.6, blur=0.8, bright=0.94, contrast=0.88,
                         font=F_HAND, font_size=26, title_font=F_CHANC, title_size=38,
                         foxing=True, fold=True),
    "aged_typed":   dict(paper=(240, 232, 210), ink=(30, 25, 18),
                         noise=0.16, rot=1.0, blur=0.55, bright=0.96, contrast=0.91,
                         font=F_COU, font_size=24, title_font=F_COUB, title_size=32,
                         foxing=True, fold=False),
    "medium_typed": dict(paper=(248, 244, 234), ink=(20, 20, 20),
                         noise=0.10, rot=0.7, blur=0.35, bright=0.98, contrast=0.95,
                         font=F_COU, font_size=24, title_font=F_COUB, title_size=32,
                         foxing=False, fold=False),
    "clean_typed":  dict(paper=(252, 250, 245), ink=(10, 10, 10),
                         noise=0.05, rot=0.35, blur=0.2,  bright=1.00, contrast=0.99,
                         font=F_COU, font_size=24, title_font=F_COUB, title_size=32,
                         foxing=False, fold=False),
}

# ── rendering helpers ─────────────────────────────────────────────────────────
def fnt(path, size):
    return ImageFont.truetype(path, size)

def wrap_text(draw, text, font, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=font) <= max_w:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines or [""]

def add_noise(img, amount):
    noise = Image.effect_noise(img.size, 255).convert("L")
    noise = noise.point(lambda p: int((p - 128) * amount) + 128)
    n3 = Image.merge("RGB", (noise, noise, noise))
    return Image.blend(img, n3, 0.2)

def add_foxing(img, rng):
    draw = ImageDraw.Draw(img)
    for _ in range(rng.randint(12, 30)):
        x, y = rng.randint(0, W), rng.randint(0, H)
        r = rng.randint(4, 22)
        alpha = rng.randint(35, 90)
        c = (rng.randint(130, 170), rng.randint(90, 130), rng.randint(50, 90))
        overlay = Image.new("RGBA", (r*2, r*2), (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        od.ellipse([0, 0, r*2, r*2], fill=(*c, alpha))
        img.paste(Image.alpha_composite(img.crop((x-r, y-r, x+r, y+r)).convert("RGBA"), overlay).convert("RGB"), (x-r, y-r))

def add_fold(img, rng):
    draw = ImageDraw.Draw(img)
    y0 = rng.randint(H//3, 2*H//3)
    for i in range(-2, 3):
        draw.line([(0, y0 + i), (W, y0 + rng.randint(-8, 8) + i)],
                  fill=(180, 168, 145), width=1)

def degrade_region(img, box, intensity=1.0):
    x0, y0, x1, y1 = (max(0, box[0]-10), max(0, box[1]-6),
                       min(W, box[2]+10), min(H, box[3]+6))
    region = img.crop((x0, y0, x1, y1))
    region = region.filter(ImageFilter.GaussianBlur(3.5 * intensity))
    region = ImageEnhance.Brightness(region).enhance(1.0 + 0.40 * intensity)
    region = ImageEnhance.Contrast(region).enhance(max(0.35, 1.0 - 0.55 * intensity))
    img.paste(region, (x0, y0))
    ov = Image.new("RGBA", (x1-x0, y1-y0), (148, 122, 68, int(65 * intensity)))
    base = img.crop((x0, y0, x1, y1)).convert("RGBA")
    img.paste(Image.alpha_composite(base, ov).convert("RGB"), (x0, y0))

def draw_stamp(img, draw, stamp, style_name, rng):
    sf = fnt(F_COU, 17)
    lines = ["FILED FOR RECORD",
             f"{stamp['rd']}  {rng.randint(8,11):02d}:{rng.randint(0,59):02d} A.M.",
             f"Recorded Vol. {stamp['vol']}, Page {stamp['page']}"]
    if stamp.get("instr"):
        lines.append(f"Instr. No. {stamp['instr']}")
    clerk_name = stamp.get("clerk", "County Clerk")
    lines += ["Deed Records, Reeves Co., TX", f"{clerk_name}, County Clerk"]
    sw = int(max(draw.textlength(l, font=sf) for l in lines)) + 28
    sx0, sy0 = W - MR - sw, 36
    sh = len(lines) * 22 + 18
    draw.rectangle([sx0, sy0, sx0 + sw, sy0 + sh], outline=(40, 40, 40), width=2)
    for i, l in enumerate(lines):
        draw.text((sx0 + 14, sy0 + 9 + i * 22), l, font=sf, fill=(40, 40, 40))
    return (sx0, sy0, sx0 + sw, sy0 + sh)

def render(doc, rng):
    st = STYLES[doc["style"]]
    img = Image.new("RGB", (W, H), st["paper"])
    draw = ImageDraw.Draw(img)
    ink = st["ink"]

    if st["foxing"]:
        add_foxing(img, rng)

    stamp_box = draw_stamp(img, draw, doc["stamp"], doc["style"], rng)
    draw = ImageDraw.Draw(img)  # redraw after paste ops

    tf = fnt(st["title_font"], st["title_size"])
    bf = fnt(st["font"], st["font_size"])
    lh = int(st["font_size"] * 1.42)
    width = W - ML - MR

    # title — start below stamp
    y = max(stamp_box[3] + 24, 44)
    for tline in doc["title"].split("\n"):
        tw = draw.textlength(tline, font=tf)
        draw.text(((W - tw) / 2, y), tline, font=tf, fill=ink)
        y += st["title_size"] + 10
    draw.line([ML, y + 4, W - MR, y + 4], fill=ink, width=2)
    y += 22

    # body — track line boxes for degradation
    deg_tokens = [t.upper() for t in (doc.get("deg") or [])]
    line_boxes = []  # (upper_text, (x0,y0,x1,y1))
    for para in doc["body"]:
        for line in wrap_text(draw, para, bf, width):
            draw.text((ML, y), line, font=bf, fill=ink)
            lw = int(draw.textlength(line, font=bf))
            line_boxes.append((line.upper(), (ML, y, ML + lw, y + lh - 4)))
            y += lh
        y += int(lh * 0.35)

    # apply inline degradations
    for upper_line, box in line_boxes:
        if any(tok in upper_line for tok in deg_tokens):
            degrade_region(img, box, intensity=1.05)

    # degrade stamp if requested
    if doc.get("deg_stamp"):
        degrade_region(img, stamp_box, intensity=1.15)

    # global effects
    if st["foxing"]:
        add_foxing(img, rng)  # second pass
    img = add_noise(img, st["noise"])
    img = ImageEnhance.Brightness(img).enhance(st["bright"])
    img = ImageEnhance.Contrast(img).enhance(st["contrast"])
    img = img.filter(ImageFilter.GaussianBlur(st["blur"]))
    if st["fold"]:
        add_fold(img, rng)
    img = img.rotate(rng.uniform(-st["rot"], st["rot"]),
                     expand=False, fillcolor=st["paper"],
                     resample=Image.BICUBIC)
    return img

# ── main ─────────────────────────────────────────────────────────────────────
def main():
    os.makedirs(OUT, exist_ok=True)
    gt_out = []
    for doc in DOCS:
        rng = random.Random(hash(doc["file"]) & 0xFFFF)
        img = render(doc, rng)
        path = os.path.join(OUT, doc["file"] + ".png")
        img.save(path, "PNG", dpi=(150, 150))
        print(f"  {os.path.relpath(path, HERE)}")

        # collect ground truth
        gt_out.append({
            "file": doc["file"] + ".png",
            "style": doc["style"],
            "degraded_fields": [f for f, v in doc["gt"].items() if v is None],
            "degraded_stamp": bool(doc.get("deg_stamp")),
            "fields": {k: v for k, v in doc["gt"].items()},
        })

    with open(os.path.join(OUT, "ground_truth.json"), "w") as f:
        json.dump(gt_out, f, indent=2)
    print(f"\n  ground_truth.json  ({len(gt_out)} entries)")

    # human-readable key
    key_lines = [
        "# Chain of Title — Ground Truth\n",
        "**Tract:** West Half (W/2) of Section 6, Block 45, T&P Ry. Co. Survey, "
        "Abstract No. 1247, Reeves County, Texas (320 acres)\n\n",
        "**Degraded fields** (model must write ILLEGIBLE, not guess): "
        "02-GRANTEE, 08-DATE_EXECUTED, 12-GRANTEE(heir), 16-DATE_EXECUTED, "
        "20-FRACTION, 28-stamp, 33-GRANTEE, 36-GRANTEE(heir), 41-FRACTION, "
        "46-DATE_EXECUTED, 48-stamp\n\n---\n",
    ]
    for entry in gt_out:
        key_lines.append(f"\n## {entry['file']}")
        for k, v in entry["fields"].items():
            key_lines.append(f"- **{k}:** {'⚠ DEGRADED — expect ILLEGIBLE' if v is None else v}")
    with open(os.path.join(OUT, "CHAIN_OF_TITLE_KEY.md"), "w") as f:
        f.write("\n".join(key_lines))

    print(f"  CHAIN_OF_TITLE_KEY.md")
    print(f"\n{len(DOCS)} documents in {OUT}")

if __name__ == "__main__":
    main()
